import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Scene } from "@babylonjs/core/scene";

import "./input-actions";
import { getRuntimeVehicleDrivetrain, IVehicleDrivetrainConfiguration, IVehicleDrivetrainState, stepVehicleDrivetrain } from "./vehicle-drivetrain";

const observers = new WeakMap<Scene, any>();
const drivetrainStates = new WeakMap<Scene, Map<string, IVehicleDrivetrainState>>();

/** Minimal previous-step wheel evidence retained by exported games for tires and drivetrain coupling. */
interface IVehicleWheelRuntimeState {
	compression: number;
	angularSpeed: number;
	rpm: number;
	grounded: boolean;
	forwardSlip: number;
}

const wheelStates = new WeakMap<Scene, Map<string, Map<string, IVehicleWheelRuntimeState>>>();

interface IVehicleFrictionCurve {
	extremumSlip: number;
	extremumValue: number;
	asymptoteSlip: number;
	asymptoteValue: number;
	stiffness: number;
}

/** Current exported-runtime raycast result retained until paired axle forces can be solved. */
interface IVehicleWheelFrame {
	antiRollGroup: string | null;
	mount: Vector3;
	grounded: boolean;
	compression: number;
}

/** Shared immutable values for one vehicle fixed-step. */
interface IVehicleStepContext {
	forward: Vector3;
	right: Vector3;
	input: { throttle: number; steering: number; brake: number; shiftUp: boolean; shiftDown: boolean };
	deltaSeconds: number;
}

function isRuntimeFrictionCurve(value: any): value is IVehicleFrictionCurve {
	return (
		!!value &&
		typeof value === "object" &&
		Number.isFinite(value.extremumSlip) &&
		value.extremumSlip >= 0.001 &&
		value.extremumSlip <= 10 &&
		Number.isFinite(value.extremumValue) &&
		value.extremumValue >= 0 &&
		value.extremumValue <= 10 &&
		Number.isFinite(value.asymptoteSlip) &&
		value.asymptoteSlip - value.extremumSlip >= 0.001 &&
		value.asymptoteSlip <= 20 &&
		Number.isFinite(value.asymptoteValue) &&
		value.asymptoteValue >= 0 &&
		value.asymptoteValue <= 10 &&
		Number.isFinite(value.stiffness) &&
		value.stiffness >= 0 &&
		value.stiffness <= 10
	);
}

/** Mirrors the documented finite origin slope and zero tangents at the extremum/asymptote. */
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

/** Combines the portable vehicle-speed cap with the active gear's engine-redline limit. */
function getMaximumWheelAngularSpeed(vehicle: any, wheel: any, drivetrain: IVehicleDrivetrainConfiguration | null, state: IVehicleDrivetrainState | null): number {
	const redlineLimit =
		drivetrain && state?.gearRatio ? (drivetrain.redlineRpm * 2 * Math.PI) / 60 / Math.abs(state.gearRatio * drivetrain.finalDriveRatio) : Number.POSITIVE_INFINITY;
	return Math.min((vehicle.maxSpeed ?? 2500) / wheel.radius, redlineLimit);
}

/** Reconstructs velocity at an authored wheel contact from rigid-body linear/angular velocity. */
function getPointVelocity(chassis: any, body: any, point: Vector3): Vector3 {
	const linearValue = body.getLinearVelocity?.();
	const angularValue = body.getAngularVelocity?.();
	const linear = linearValue instanceof Vector3 ? linearValue : new Vector3(linearValue?.x ?? 0, linearValue?.y ?? 0, linearValue?.z ?? 0);
	const angular = angularValue instanceof Vector3 ? angularValue : new Vector3(angularValue?.x ?? 0, angularValue?.y ?? 0, angularValue?.z ?? 0);
	const centerOfMass = body.getMassProperties?.().centerOfMass;
	const center = centerOfMass ? Vector3.TransformCoordinates(centerOfMass, chassis.getWorldMatrix()) : chassis.getAbsolutePosition();
	return linear.add(Vector3.Cross(angular, point.subtract(center)));
}

function vehicles(scene: Scene): any[] {
	return Array.isArray(scene.metadata?.babylonEditorVehicles) ? scene.metadata.babylonEditorVehicles : [];
}

/** Returns a detached live drivetrain snapshot for exported game UI, audio, or telemetry scripts. */
export function getVehicleDrivetrainRuntimeState(scene: Scene, vehicleId: string): IVehicleDrivetrainState | null {
	return structuredClone(drivetrainStates.get(scene)?.get(vehicleId) ?? null);
}

function isPhysicsMesh(node: any): node is AbstractMesh & { physicsAggregate: any } {
	return !!node?.physicsAggregate && typeof node.getDirection === "function" && typeof node.getAbsolutePosition === "function";
}

/** Reads normalized driving and edge-triggered shift actions from the exported Input Actions runtime. */
function getInput(scene: Scene, vehicle: any): { throttle: number; steering: number; brake: number; shiftUp: boolean; shiftDown: boolean } {
	const input = scene.inputActions;
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

/** Couples an authored axle only after both wheel raycasts have produced current-step compression. */
function applyAntiRollForces(vehicle: any, body: any, up: Vector3, frame: IVehicleWheelFrame[]): void {
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
		// Invalid legacy metadata is ignored here; editor/MCP authoring requires exact two-wheel groups.
		if (wheels.length !== 2) {
			continue;
		}
		const [first, second] = wheels;
		const force = Math.max(-maximumForce, Math.min(maximumForce, (first.compression - second.compression) * stiffness));
		if (first.grounded && force) {
			body.applyForce?.(up.scale(force), first.mount);
		}
		if (second.grounded && force) {
			body.applyForce?.(up.scale(-force), second.mount);
		}
	}
}

/** Applies suspension/traction per wheel before the order-independent anti-roll solve. */
function applyWheelSuspension(scene: Scene, vehicle: any, chassis: any, body: any, context: IVehicleStepContext): boolean {
	if (!Array.isArray(vehicle.wheels) || !vehicle.wheels.length) {
		return false;
	}
	const physics = scene.getPhysicsEngine() as any;
	if (!physics?.raycast) {
		return false;
	}
	const up = chassis.getDirection(Vector3.Up()).normalize();
	const world = chassis.getWorldMatrix();
	const { forward, right, input, deltaSeconds } = context;
	const mass = body.getMassProperties?.().mass ?? 1;
	const drivenCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.driven).length);
	const brakeCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.brake).length);
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
			context.input,
			vehicle.wheels.map((wheel: any) => {
				const state = states.get(wheel.id);
				return { id: wheel.id, rpm: state?.rpm ?? 0, driven: !!wheel.driven, grounded: state?.grounded ?? false, forwardSlip: state?.forwardSlip ?? 0 };
			}),
			context.deltaSeconds
		);
		sceneDrivetrainStates.set(vehicle.id, drivetrainState);
	}
	const frame: IVehicleWheelFrame[] = [];
	for (const wheel of vehicle.wheels) {
		const wheelTorque = drivetrainState?.wheelTorques[wheel.id];
		const mount = Vector3.TransformCoordinates(Vector3.FromArray(wheel.connectionPoint), world);
		const antiRollGroup = typeof wheel.antiRollGroup === "string" && wheel.antiRollGroup ? wheel.antiRollGroup : null;
		const rayLength = wheel.suspensionRestLength + wheel.maxTravel + wheel.radius;
		const result = physics.raycast(mount, mount.subtract(up.scale(rayLength)), { ignoreBody: body });
		const existing = states.get(wheel.id);
		const previous = existing ?? { compression: 0, angularSpeed: 0, rpm: 0, grounded: false, forwardSlip: 0 };
		if (!result?.hasHit) {
			let angularSpeed = previous.angularSpeed;
			// Match editor N·m torque integration while retaining the curve-only legacy force path.
			if (isRuntimeFrictionCurve(wheel.forwardFriction ?? vehicle.forwardFriction)) {
				const inertia = Math.max(0.5 * (wheel.mass ?? 20) * wheel.radius * wheel.radius, 0.001);
				if (wheelTorque) {
					angularSpeed += ((wheelTorque.totalTorque * 100) / inertia) * deltaSeconds;
				} else if (!drivetrainState) {
					const driveForce = wheel.driven ? ((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount : 0;
					angularSpeed += ((driveForce * wheel.radius) / inertia) * deltaSeconds;
				}
				if (wheel.brake && input.brake > 0) {
					const brakeForce = ((vehicle.maxBrakeForce ?? 35000) / brakeCount) * input.brake;
					const brakeAcceleration = (brakeForce * wheel.radius) / inertia;
					angularSpeed = moveTowards(angularSpeed, 0, brakeAcceleration * deltaSeconds);
				}
				const maximumAngularSpeed = getMaximumWheelAngularSpeed(vehicle, wheel, drivetrain, drivetrainState);
				angularSpeed = Math.max(-maximumAngularSpeed, Math.min(maximumAngularSpeed, angularSpeed));
			}
			angularSpeed *= Math.exp(-(wheel.dampingRate ?? 0.25) * deltaSeconds);
			states.set(wheel.id, { compression: 0, angularSpeed, rpm: (angularSpeed * 60) / (Math.PI * 2), grounded: false, forwardSlip: 0 });
			frame.push({ antiRollGroup, mount, grounded: false, compression: 0 });
			continue;
		}
		const suspensionLength = Math.max(0, result.hitDistance - wheel.radius);
		const compression = Math.max(0, Math.min(wheel.suspensionRestLength + wheel.maxTravel, wheel.suspensionRestLength - suspensionLength));
		const hitPoint = result.hitPointWorld ?? result.hitPoint;
		const contact = hitPoint instanceof Vector3 ? hitPoint : new Vector3(hitPoint.x, hitPoint.y, hitPoint.z);
		const compressionVelocity = (compression - previous.compression) / Math.max(deltaSeconds, 1 / 120);
		const suspensionForce = Math.max(0, wheel.springStrength * compression + wheel.damping * compressionVelocity);
		if (suspensionForce) {
			body.applyForce?.(up.scale(suspensionForce), mount);
		}
		const steerAngle = wheel.steering ? input.steering * (vehicle.maxSteerAngle ?? 0.55) : 0;
		const wheelForward = steerAngle ? Vector3.TransformNormal(forward, Matrix.RotationAxis(up, steerAngle)).normalize() : forward;
		const wheelRight = Vector3.Cross(up, wheelForward).normalize();
		const forwardCurve = isRuntimeFrictionCurve(wheel.forwardFriction ?? vehicle.forwardFriction) ? (wheel.forwardFriction ?? vehicle.forwardFriction) : null;
		const sidewaysCurve = isRuntimeFrictionCurve(wheel.sidewaysFriction ?? vehicle.sidewaysFriction) ? (wheel.sidewaysFriction ?? vehicle.sidewaysFriction) : null;
		const velocity = forwardCurve || sidewaysCurve ? getPointVelocity(chassis, body, contact) : (body.getLinearVelocity?.() ?? Vector3.Zero());
		const longitudinalSpeed = Vector3.Dot(velocity, wheelForward);
		const lateralSpeed = Vector3.Dot(velocity, wheelRight);
		let angularSpeed = existing ? previous.angularSpeed : longitudinalSpeed / wheel.radius;
		let forwardSlip = 0;
		if (forwardCurve) {
			const wheelMass = wheel.mass ?? 20;
			const inertia = Math.max(0.5 * wheelMass * wheel.radius * wheel.radius, 0.001);
			if (wheelTorque) {
				angularSpeed += ((wheelTorque.totalTorque * 100) / inertia) * deltaSeconds;
			} else if (!drivetrainState) {
				const canAccelerate = Math.abs(longitudinalSpeed) < (vehicle.maxSpeed ?? 2500) || Math.sign(input.throttle) !== Math.sign(longitudinalSpeed);
				const driveForce = wheel.driven && canAccelerate ? ((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount : 0;
				angularSpeed += ((driveForce * wheel.radius) / inertia) * deltaSeconds;
			}
			if (wheel.brake && input.brake > 0) {
				const brakeForce = ((vehicle.maxBrakeForce ?? 35000) / brakeCount) * input.brake;
				const brakeAcceleration = (brakeForce * wheel.radius) / inertia;
				angularSpeed = moveTowards(angularSpeed, 0, brakeAcceleration * deltaSeconds);
			}
			angularSpeed *= Math.exp(-(wheel.dampingRate ?? 0.25) * deltaSeconds);
			const surfaceSpeed = angularSpeed * wheel.radius;
			forwardSlip = (longitudinalSpeed - surfaceSpeed) / Math.max(Math.abs(longitudinalSpeed), 100);
			const normalLoad = Math.max(suspensionForce, (mass * Math.max(scene.gravity?.length() ?? 981, 1)) / vehicle.wheels.length);
			const capacity = normalLoad * evaluateFrictionCurve(forwardCurve, forwardSlip);
			const desiredForce = (-(longitudinalSpeed - surfaceSpeed) * mass) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length;
			const forwardForce = Math.max(-capacity, Math.min(capacity, desiredForce));
			if (Math.abs(forwardForce) > 0.001) {
				body.applyForce?.(wheelForward.scale(forwardForce), contact);
				angularSpeed -= ((forwardForce * wheel.radius) / inertia) * deltaSeconds;
			}
			const maximumAngularSpeed = getMaximumWheelAngularSpeed(vehicle, wheel, drivetrain, drivetrainState);
			angularSpeed = Math.max(-maximumAngularSpeed, Math.min(maximumAngularSpeed, angularSpeed));
		} else {
			if (wheel.driven && input.throttle) {
				body.applyForce?.(wheelForward.scale(((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount), contact);
			}
			if (wheel.brake && input.brake > 0 && velocity.lengthSquared() > 0.001) {
				body.applyForce?.(velocity.normalize().scale((-(vehicle.maxBrakeForce ?? 35000) * input.brake) / brakeCount), contact);
			}
		}
		if (sidewaysCurve) {
			const sidewaysSlip = lateralSpeed / Math.max(Math.abs(longitudinalSpeed), 100);
			const normalLoad = Math.max(suspensionForce, (mass * Math.max(scene.gravity?.length() ?? 981, 1)) / vehicle.wheels.length);
			const capacity = normalLoad * evaluateFrictionCurve(sidewaysCurve, sidewaysSlip);
			const desiredForce = (-lateralSpeed * mass) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length;
			const sidewaysForce = Math.max(-capacity, Math.min(capacity, desiredForce));
			if (Math.abs(sidewaysForce) > 0.001) {
				body.applyForce?.(wheelRight.scale(sidewaysForce), contact);
			}
		} else if (Math.abs(lateralSpeed) > 0.001) {
			body.applyForce?.(right.scale((-lateralSpeed * mass * (vehicle.lateralGrip ?? 12)) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length), contact);
		}
		states.set(wheel.id, { compression, angularSpeed, rpm: (angularSpeed * 60) / (Math.PI * 2), grounded: true, forwardSlip });
		frame.push({ antiRollGroup, mount, grounded: true, compression });
	}
	applyAntiRollForces(vehicle, body, up, frame);
	return true;
}

function applyVehicle(scene: Scene, vehicle: any, deltaSeconds: number): void {
	if (!vehicle.enabled) {
		return;
	}
	const chassis = scene.getNodeById(vehicle.chassisNodeId);
	if (!isPhysicsMesh(chassis)) {
		return;
	}
	const body = chassis.physicsAggregate.body as any;
	if (body.getMotionType?.() !== PhysicsMotionType.DYNAMIC) {
		return;
	}
	const velocity = body.getLinearVelocity?.();
	if (!velocity) {
		return;
	}
	const input = getInput(scene, vehicle);
	chassis.computeWorldMatrix(true);
	const forward = chassis.getDirection(Vector3.Forward()).normalize();
	const right = chassis.getDirection(Vector3.Right()).normalize();
	const forwardSpeed = Vector3.Dot(velocity, forward);
	const lateralSpeed = Vector3.Dot(velocity, right);
	const steering = input.steering * (vehicle.maxSteerAngle ?? 0.55);
	const steeredForward = new Vector3(
		forward.x * Math.cos(steering) + right.x * Math.sin(steering),
		forward.y,
		forward.z * Math.cos(steering) + right.z * Math.sin(steering)
	).normalize();
	const canAccelerate = Math.abs(forwardSpeed) < (vehicle.maxSpeed ?? 2500) || Math.sign(input.throttle) !== Math.sign(forwardSpeed);
	const mass = body.getMassProperties?.().mass ?? 1;
	const position = chassis.getAbsolutePosition();
	if (applyWheelSuspension(scene, vehicle, chassis, body, { forward, right, input, deltaSeconds })) {
		return;
	}
	if (canAccelerate && input.throttle) {
		body.applyForce?.(steeredForward.scale((vehicle.maxEngineForce ?? 25000) * input.throttle), position.add(forward.scale(vehicle.wheelBase ?? 180)));
	}
	if (Math.abs(lateralSpeed) > 0.001) {
		body.applyForce?.(right.scale((-lateralSpeed * mass * (vehicle.lateralGrip ?? 12)) / Math.max(deltaSeconds, 1 / 120)), position);
	}
	if (input.brake > 0 && velocity.lengthSquared() > 0.001) {
		body.applyForce?.(velocity.normalize().scale(-(vehicle.maxBrakeForce ?? 35000) * input.brake), position);
	}
}

/** Attaches persisted arcade-vehicle chassis controllers after physics and input actions load. */
export function configureVehicles(scene: Scene): void {
	if (observers.has(scene) || !vehicles(scene).length) {
		return;
	}
	observers.set(
		scene,
		scene.onBeforePhysicsObservable.add(() => {
			const deltaSeconds = Math.min(Math.max((scene.getPhysicsEngine() as any)?.getTimeStep?.() ?? scene.getEngine().getDeltaTime() / 1000, 0), 1 / 30);
			if (!deltaSeconds) {
				return;
			}
			vehicles(scene).forEach((vehicle) => applyVehicle(scene, vehicle, deltaSeconds));
		})
	);
}

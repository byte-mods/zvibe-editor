import type { IPhysics2DMassProperties } from "./physics2d-mass";
import type {
	IPhysics2DAnchoredJointConfiguration,
	IPhysics2DDistanceJointConfiguration,
	IPhysics2DFixedJointConfiguration,
	IPhysics2DHingeJointConfiguration,
	IPhysics2DJointConfiguration,
} from "./physics2d-joints";
import type { IPhysics2DPoint } from "./physics2d-polygons";
import type { IPhysics2DWorldConfiguration } from "./physics2d-settings";
import type { IPhysics2DBodyConfiguration } from "./physics2d-types";

const MinimumConstraintLength = 0.000001;
const MaximumLinearVelocity = 1_000_000;
const MaximumAngularVelocity = 100_000;

export interface IPhysics2DJointRuntimeBody {
	config: IPhysics2DBodyConfiguration;
	world: IPhysics2DWorldConfiguration;
	node: { position: { x: number; y: number }; rotation: { z: number } };
	readPosition2D: () => IPhysics2DPoint;
	readAngle2D: () => number;
	translate2D: (delta: IPhysics2DPoint) => void;
	rotate2D: (delta: number) => void;
	velocity: { x: number; y: number };
	angularVelocity: number;
	massProperties: IPhysics2DMassProperties;
}

export interface IPhysics2DRuntimeJoint {
	source: unknown;
	config: IPhysics2DJointConfiguration;
	first: IPhysics2DJointRuntimeBody;
	second?: IPhysics2DJointRuntimeBody;
	broken: boolean;
	breakNotified: boolean;
	reactionLinearImpulse: IPhysics2DPoint;
	reactionAngularImpulse: number;
	linearMotorImpulse: IPhysics2DPoint;
	motorImpulse: number;
	lastStepSeconds: number;
}

export interface IPhysics2DJointRuntimeState {
	active: boolean;
	id: string;
	type: IPhysics2DJointConfiguration["type"];
	revision: number;
	enabled: boolean;
	connected: boolean;
	broken: boolean;
	reactionForce: IPhysics2DPoint;
	reactionTorque: number;
}

type IAnchoredCoreJoint = IPhysics2DDistanceJointConfiguration | IPhysics2DFixedJointConfiguration | IPhysics2DHingeJointConfiguration;
type IConstraintPoints = { first: IPhysics2DPoint; second: IPhysics2DPoint };
type ILinearVelocityConstraint = {
	points: IConstraintPoints;
	axis: IPhysics2DPoint;
	error: number;
	stepSeconds: number;
	stiffness?: number;
	damping?: number;
};
type ILimitedLinearVelocityConstraint = ILinearVelocityConstraint & { maximumForce: number; targetSpeed?: number };
type IAngularVelocityConstraint = {
	targetSpeed: number;
	error: number;
	stepSeconds: number;
	maximumTorque?: number;
	damping?: number;
	constrainTranslation?: boolean;
	stiffness?: number;
};

function rotate(point: IPhysics2DPoint, angle: number): IPhysics2DPoint {
	const cosine = Math.cos(angle);
	const sine = Math.sin(angle);
	return [point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine];
}

function worldPoint(body: IPhysics2DJointRuntimeBody, local: IPhysics2DPoint): IPhysics2DPoint {
	const rotated = rotate(local, body.readAngle2D());
	const position = body.readPosition2D();
	return [position[0] + rotated[0], position[1] + rotated[1]];
}

function localPoint(body: IPhysics2DJointRuntimeBody, world: IPhysics2DPoint): IPhysics2DPoint {
	const position = body.readPosition2D();
	return rotate([world[0] - position[0], world[1] - position[1]], -body.readAngle2D());
}

function center(body: IPhysics2DJointRuntimeBody): IPhysics2DPoint {
	return worldPoint(body, body.massProperties.centerOfMass);
}

function anchorPoints(joint: IPhysics2DRuntimeJoint): IConstraintPoints {
	const config = joint.config as IPhysics2DAnchoredJointConfiguration;
	return {
		first: worldPoint(joint.first, config.firstAnchor),
		second: joint.second ? worldPoint(joint.second, config.secondAnchor) : config.secondAnchor,
	};
}

function arm(body: IPhysics2DJointRuntimeBody, point: IPhysics2DPoint): IPhysics2DPoint {
	const bodyCenter = center(body);
	return [point[0] - bodyCenter[0], point[1] - bodyCenter[1]];
}

function cross(first: IPhysics2DPoint, second: IPhysics2DPoint): number {
	return first[0] * second[1] - first[1] * second[0];
}

function inverseMass(body: IPhysics2DJointRuntimeBody | undefined, axis: 0 | 1): number {
	if (!body || body.config.bodyType !== "dynamic" || (axis === 0 ? body.config.freezePositionX : body.config.freezePositionY)) {
		return 0;
	}
	return body.massProperties.inverseMass;
}

function inverseInertia(body: IPhysics2DJointRuntimeBody | undefined): number {
	return body && body.config.bodyType === "dynamic" && !body.config.freezeRotation ? body.massProperties.inverseInertia : 0;
}

function constrainedInverseInertia(body: IPhysics2DJointRuntimeBody | undefined, pointArm: IPhysics2DPoint): number {
	const angularInverse = inverseInertia(body);
	if (!body || angularInverse <= 0) {
		return 0;
	}
	const inertia = 1 / angularInverse;
	const translationInertia = (inverseMass(body, 0) > 0 ? pointArm[1] ** 2 / inverseMass(body, 0) : 0) + (inverseMass(body, 1) > 0 ? pointArm[0] ** 2 / inverseMass(body, 1) : 0);
	return 1 / (inertia + translationInertia);
}

function effectiveLinearMass(joint: IPhysics2DRuntimeJoint, axis: IPhysics2DPoint, firstArm: IPhysics2DPoint, secondArm: IPhysics2DPoint): number {
	return (
		inverseMass(joint.first, 0) * axis[0] ** 2 +
		inverseMass(joint.first, 1) * axis[1] ** 2 +
		inverseMass(joint.second, 0) * axis[0] ** 2 +
		inverseMass(joint.second, 1) * axis[1] ** 2 +
		cross(firstArm, axis) ** 2 * inverseInertia(joint.first) +
		cross(secondArm, axis) ** 2 * inverseInertia(joint.second)
	);
}

function pointVelocity(body: IPhysics2DJointRuntimeBody | undefined, pointArm: IPhysics2DPoint): IPhysics2DPoint {
	return body ? [body.velocity.x - body.angularVelocity * pointArm[1], body.velocity.y + body.angularVelocity * pointArm[0]] : [0, 0];
}

function applyLinearVelocityImpulse(joint: IPhysics2DRuntimeJoint, axis: IPhysics2DPoint, impulse: number, firstArm: IPhysics2DPoint, secondArm: IPhysics2DPoint): void {
	const firstX = joint.first.velocity.x - axis[0] * impulse * inverseMass(joint.first, 0);
	const firstY = joint.first.velocity.y - axis[1] * impulse * inverseMass(joint.first, 1);
	const firstAngular = joint.first.angularVelocity - cross(firstArm, axis) * impulse * inverseInertia(joint.first);
	const secondX = joint.second ? joint.second.velocity.x + axis[0] * impulse * inverseMass(joint.second, 0) : 0;
	const secondY = joint.second ? joint.second.velocity.y + axis[1] * impulse * inverseMass(joint.second, 1) : 0;
	const secondAngular = joint.second ? joint.second.angularVelocity + cross(secondArm, axis) * impulse * inverseInertia(joint.second) : 0;
	if (
		![firstX, firstY, firstAngular, secondX, secondY, secondAngular].every(Number.isFinite) ||
		Math.abs(firstX) > MaximumLinearVelocity ||
		Math.abs(firstY) > MaximumLinearVelocity ||
		Math.abs(firstAngular) > MaximumAngularVelocity ||
		Math.abs(secondX) > MaximumLinearVelocity ||
		Math.abs(secondY) > MaximumLinearVelocity ||
		Math.abs(secondAngular) > MaximumAngularVelocity
	) {
		throw new Error(`Physics 2D joint "${joint.config.id}" would exceed the bounded runtime velocity range.`);
	}
	joint.first.velocity.x = firstX;
	joint.first.velocity.y = firstY;
	joint.first.angularVelocity = firstAngular;
	if (joint.second) {
		joint.second.velocity.x = secondX;
		joint.second.velocity.y = secondY;
		joint.second.angularVelocity = secondAngular;
	}
	joint.reactionLinearImpulse[0] += axis[0] * impulse;
	joint.reactionLinearImpulse[1] += axis[1] * impulse;
}

function applyAngularVelocityImpulse(joint: IPhysics2DRuntimeJoint, impulse: number): void {
	const first = joint.first.angularVelocity - impulse * inverseInertia(joint.first);
	const second = joint.second ? joint.second.angularVelocity + impulse * inverseInertia(joint.second) : 0;
	if (![first, second].every(Number.isFinite) || Math.abs(first) > MaximumAngularVelocity || Math.abs(second) > MaximumAngularVelocity) {
		throw new Error(`Physics 2D joint "${joint.config.id}" would exceed the bounded runtime angular velocity range.`);
	}
	joint.first.angularVelocity = first;
	if (joint.second) {
		joint.second.angularVelocity = second;
	}
	joint.reactionAngularImpulse += impulse;
}

function solveLinearVelocityAtPoints(joint: IPhysics2DRuntimeJoint, constraint: ILinearVelocityConstraint): void {
	const { points, axis, error, stepSeconds, stiffness = 0.2, damping = 1 } = constraint;
	const firstArm = arm(joint.first, points.first);
	const secondArm = joint.second ? arm(joint.second, points.second) : ([0, 0] as IPhysics2DPoint);
	const denominator = effectiveLinearMass(joint, axis, firstArm, secondArm);
	if (denominator <= 0) {
		return;
	}
	const firstVelocity = pointVelocity(joint.first, firstArm);
	const secondVelocity = pointVelocity(joint.second, secondArm);
	const relative = (secondVelocity[0] - firstVelocity[0]) * axis[0] + (secondVelocity[1] - firstVelocity[1]) * axis[1];
	const bias = Math.max(-MaximumLinearVelocity, Math.min(MaximumLinearVelocity, (error * stiffness) / Math.max(stepSeconds, MinimumConstraintLength)));
	applyLinearVelocityImpulse(joint, axis, -(relative * damping + bias) / denominator, firstArm, secondArm);
}

function solveLinearVelocity(joint: IPhysics2DRuntimeJoint, axis: IPhysics2DPoint, error: number, stepSeconds: number, stiffness = 0.2, damping = 1): void {
	solveLinearVelocityAtPoints(joint, { points: anchorPoints(joint), axis, error, stepSeconds, stiffness, damping });
}

function solveLimitedLinearVelocityAtPoints(joint: IPhysics2DRuntimeJoint, constraint: ILimitedLinearVelocityConstraint): void {
	const { points, axis, error, stepSeconds, maximumForce, targetSpeed = 0, stiffness = 0.2, damping = 1 } = constraint;
	const firstArm = arm(joint.first, points.first);
	const secondArm = joint.second ? arm(joint.second, points.second) : ([0, 0] as IPhysics2DPoint);
	const denominator = effectiveLinearMass(joint, axis, firstArm, secondArm);
	if (denominator <= 0 || maximumForce <= 0) {
		return;
	}
	const firstVelocity = pointVelocity(joint.first, firstArm);
	const secondVelocity = pointVelocity(joint.second, secondArm);
	const relative = (secondVelocity[0] - firstVelocity[0]) * axis[0] + (secondVelocity[1] - firstVelocity[1]) * axis[1];
	const bias = Math.max(-MaximumLinearVelocity, Math.min(MaximumLinearVelocity, (error * stiffness) / Math.max(stepSeconds, MinimumConstraintLength)));
	const impulse = -((relative - targetSpeed) * damping + bias) / denominator;
	const proposed: IPhysics2DPoint = [joint.linearMotorImpulse[0] + axis[0] * impulse, joint.linearMotorImpulse[1] + axis[1] * impulse];
	const maximumImpulse = maximumForce * 100 * stepSeconds;
	const length = Math.hypot(proposed[0], proposed[1]);
	const next: IPhysics2DPoint = length > maximumImpulse ? [(proposed[0] * maximumImpulse) / length, (proposed[1] * maximumImpulse) / length] : proposed;
	const delta: IPhysics2DPoint = [next[0] - joint.linearMotorImpulse[0], next[1] - joint.linearMotorImpulse[1]];
	if (delta[0]) {
		applyLinearVelocityImpulse(joint, [1, 0], delta[0], firstArm, secondArm);
	}
	if (delta[1]) {
		applyLinearVelocityImpulse(joint, [0, 1], delta[1], firstArm, secondArm);
	}
	joint.linearMotorImpulse = next;
}

function solveLinearPositionAtPoints(
	joint: IPhysics2DRuntimeJoint,
	points: { first: IPhysics2DPoint; second: IPhysics2DPoint },
	axis: IPhysics2DPoint,
	error: number,
	stepSeconds: number,
	stiffness = 1
): void {
	const firstArm = arm(joint.first, points.first);
	const secondArm = joint.second ? arm(joint.second, points.second) : ([0, 0] as IPhysics2DPoint);
	const denominator = effectiveLinearMass(joint, axis, firstArm, secondArm);
	if (denominator <= 0) {
		return;
	}
	const impulse = (-error * stiffness) / denominator;
	joint.first.translate2D([-axis[0] * impulse * inverseMass(joint.first, 0), -axis[1] * impulse * inverseMass(joint.first, 1)]);
	joint.first.rotate2D(-cross(firstArm, axis) * impulse * inverseInertia(joint.first));
	if (joint.second) {
		joint.second.translate2D([axis[0] * impulse * inverseMass(joint.second, 0), axis[1] * impulse * inverseMass(joint.second, 1)]);
		joint.second.rotate2D(cross(secondArm, axis) * impulse * inverseInertia(joint.second));
	}
	// Convert positional correction into an impulse estimate so break thresholds include severe initial errors.
	joint.reactionLinearImpulse[0] += (axis[0] * impulse) / Math.max(stepSeconds, MinimumConstraintLength);
	joint.reactionLinearImpulse[1] += (axis[1] * impulse) / Math.max(stepSeconds, MinimumConstraintLength);
}

function solveLinearPosition(joint: IPhysics2DRuntimeJoint, axis: IPhysics2DPoint, error: number, stepSeconds: number, stiffness = 1): void {
	solveLinearPositionAtPoints(joint, anchorPoints(joint), axis, error, stepSeconds, stiffness);
}

function solvePointVelocity(joint: IPhysics2DRuntimeJoint, stepSeconds: number, stiffness = 0.2, damping = 1): void {
	for (const axis of [
		[1, 0],
		[0, 1],
	] as IPhysics2DPoint[]) {
		const points = anchorPoints(joint);
		const error = (points.second[0] - points.first[0]) * axis[0] + (points.second[1] - points.first[1]) * axis[1];
		solveLinearVelocity(joint, axis, error, stepSeconds, stiffness, damping);
	}
}

function solvePointPosition(joint: IPhysics2DRuntimeJoint, stepSeconds: number, stiffness = 1): void {
	for (const axis of [
		[1, 0],
		[0, 1],
	] as IPhysics2DPoint[]) {
		const points = anchorPoints(joint);
		const error = (points.second[0] - points.first[0]) * axis[0] + (points.second[1] - points.first[1]) * axis[1];
		solveLinearPosition(joint, axis, error, stepSeconds, stiffness);
	}
}

function solveAngularVelocity(joint: IPhysics2DRuntimeJoint, constraint: IAngularVelocityConstraint): void {
	const { targetSpeed, error, stepSeconds, maximumTorque, damping = 1, constrainTranslation = true, stiffness = 0.2 } = constraint;
	const denominator = (() => {
		if (!constrainTranslation) {
			return inverseInertia(joint.first) + inverseInertia(joint.second);
		}
		const points = anchorPoints(joint);
		return (
			constrainedInverseInertia(joint.first, arm(joint.first, points.first)) +
			constrainedInverseInertia(joint.second, joint.second ? arm(joint.second, points.second) : [0, 0])
		);
	})();
	if (denominator <= 0) {
		return;
	}
	const relative = (joint.second?.angularVelocity ?? 0) - joint.first.angularVelocity;
	let impulse = -((relative - targetSpeed) * damping + (error * stiffness) / Math.max(stepSeconds, MinimumConstraintLength)) / denominator;
	if (maximumTorque !== undefined) {
		const maximumImpulse = maximumTorque * 100 * stepSeconds;
		const next = Math.max(-maximumImpulse, Math.min(joint.motorImpulse + impulse, maximumImpulse));
		impulse = next - joint.motorImpulse;
		joint.motorImpulse = next;
	}
	applyAngularVelocityImpulse(joint, impulse);
}

function solveAngularPosition(joint: IPhysics2DRuntimeJoint, error: number, stepSeconds: number, stiffness = 1): void {
	const denominator = inverseInertia(joint.first) + inverseInertia(joint.second);
	if (denominator <= 0) {
		return;
	}
	const impulse = (-error * stiffness) / denominator;
	joint.first.rotate2D(-impulse * inverseInertia(joint.first));
	if (joint.second) {
		joint.second.rotate2D(impulse * inverseInertia(joint.second));
	}
	joint.reactionAngularImpulse += impulse / Math.max(stepSeconds, MinimumConstraintLength);
}

function angularError(joint: IPhysics2DRuntimeJoint, referenceAngle: number): number {
	return (joint.second?.readAngle2D() ?? 0) - joint.first.readAngle2D() - referenceAngle;
}

function distanceState(joint: IPhysics2DRuntimeJoint, config: { distance: number; maxDistanceOnly?: boolean }): { axis: IPhysics2DPoint; error: number } | null {
	const points = anchorPoints(joint);
	const delta: IPhysics2DPoint = [points.second[0] - points.first[0], points.second[1] - points.first[1]];
	const length = Math.hypot(delta[0], delta[1]);
	if (config.maxDistanceOnly && length <= config.distance) {
		return null;
	}
	if (length <= MinimumConstraintLength && config.distance <= MinimumConstraintLength) {
		return { axis: [1, 0], error: 0 };
	}
	return { axis: length > MinimumConstraintLength ? [delta[0] / length, delta[1] / length] : [1, 0], error: length - config.distance };
}

/** Resolves legacy auto-anchors once from the initial authored pose. */
export function resolvePhysics2DJointAutoConfiguration(
	config: IPhysics2DJointConfiguration,
	first: IPhysics2DJointRuntimeBody,
	second?: IPhysics2DJointRuntimeBody
): IPhysics2DJointConfiguration {
	if (!("autoConfigureConnectedAnchor" in config) || !config.autoConfigureConnectedAnchor) {
		return config;
	}
	if (config.type === "distance" || config.type === "spring") {
		return { ...config, autoConfigureConnectedAnchor: false };
	}
	const firstWorld = worldPoint(first, config.firstAnchor);
	const secondAnchor = second ? localPoint(second, firstWorld) : firstWorld;
	const referenceAngle = second ? second.readAngle2D() - first.readAngle2D() : -first.readAngle2D();
	return {
		...config,
		secondAnchor,
		autoConfigureConnectedAnchor: false,
		...(["fixed", "hinge", "slider"].includes(config.type) ? { referenceAngle } : {}),
	} as IPhysics2DJointConfiguration;
}

export function isPhysics2DCoreJoint(config: IPhysics2DJointConfiguration): config is IAnchoredCoreJoint {
	return config.type === "distance" || config.type === "fixed" || config.type === "hinge";
}

function frequencyStiffness(frequency: number, stepSeconds: number): number {
	return frequency === 0 ? 1 : Math.min(1, Math.max(0.05, frequency * Math.PI * 2 * stepSeconds));
}

function localConstraintAxis(joint: IPhysics2DRuntimeJoint, angle: number): IPhysics2DPoint {
	return rotate([Math.cos(angle), Math.sin(angle)], joint.first.readAngle2D());
}

function anchoredTranslation(joint: IPhysics2DRuntimeJoint, axis: IPhysics2DPoint): number {
	const points = anchorPoints(joint);
	return (points.second[0] - points.first[0]) * axis[0] + (points.second[1] - points.first[1]) * axis[1];
}

function relativeConstraintPoints(joint: IPhysics2DRuntimeJoint): { first: IPhysics2DPoint; second: IPhysics2DPoint; offset: IPhysics2DPoint } {
	const first = center(joint.first);
	if (joint.second) {
		return { first, second: center(joint.second), offset: joint.config.type === "relative" ? rotate(joint.config.linearOffset, joint.first.readAngle2D()) : [0, 0] };
	}
	const target: IPhysics2DPoint = joint.config.type === "target" ? joint.config.target : joint.config.type === "relative" ? joint.config.linearOffset : [0, 0];
	return { first, second: target, offset: [0, 0] };
}

export function beginPhysics2DJointStep(joint: IPhysics2DRuntimeJoint, stepSeconds: number): void {
	joint.reactionLinearImpulse = [0, 0];
	joint.reactionAngularImpulse = 0;
	joint.linearMotorImpulse = [0, 0];
	joint.motorImpulse = 0;
	joint.lastStepSeconds = stepSeconds;
}

export function beginPhysics2DJointSubstep(joint: IPhysics2DRuntimeJoint): void {
	joint.linearMotorImpulse = [0, 0];
	joint.motorImpulse = 0;
}

export function solvePhysics2DJointVelocity(joint: IPhysics2DRuntimeJoint, stepSeconds: number): void {
	if (joint.broken || !joint.config.enabled) {
		return;
	}
	const config = joint.config;
	if (config.type === "distance") {
		const state = distanceState(joint, config);
		if (!state) {
			return;
		}
		if (config.distance <= MinimumConstraintLength && Math.abs(state.error) <= MinimumConstraintLength) {
			solvePointVelocity(joint, stepSeconds);
		} else {
			solveLinearVelocity(joint, state.axis, state.error, stepSeconds);
		}
		return;
	}
	if (config.type === "spring") {
		const state = distanceState(joint, config);
		if (state) {
			solveLinearVelocity(joint, state.axis, state.error, stepSeconds, frequencyStiffness(config.frequency, stepSeconds), config.dampingRatio);
		}
		return;
	}
	if (config.type === "fixed") {
		const stiffness = frequencyStiffness(config.frequency, stepSeconds);
		solvePointVelocity(joint, stepSeconds, stiffness, config.dampingRatio);
		solveAngularVelocity(joint, { targetSpeed: 0, error: angularError(joint, config.referenceAngle), stepSeconds, damping: config.dampingRatio });
		return;
	}
	if (config.type === "hinge") {
		// Motor/limit impulses establish angular motion first; the pivot then creates matching tangential center velocity.
		if (config.useMotor) {
			solveAngularVelocity(joint, { targetSpeed: config.motorSpeed, error: 0, stepSeconds, maximumTorque: config.maxMotorTorque });
		}
		if (config.useLimits) {
			const error = angularError(joint, config.referenceAngle);
			const relativeSpeed = (joint.second?.angularVelocity ?? 0) - joint.first.angularVelocity;
			if ((error <= config.minAngle && relativeSpeed < 0) || (error >= config.maxAngle && relativeSpeed > 0)) {
				solveAngularVelocity(joint, { targetSpeed: 0, error: error < config.minAngle ? error - config.minAngle : error - config.maxAngle, stepSeconds });
			}
		}
		solvePointVelocity(joint, stepSeconds);
		return;
	}
	if (config.type === "friction") {
		const points = anchorPoints(joint);
		for (const axis of [
			[1, 0],
			[0, 1],
		] as IPhysics2DPoint[]) {
			solveLimitedLinearVelocityAtPoints(joint, { points, axis, error: 0, stepSeconds, maximumForce: config.maxForce, targetSpeed: 0, stiffness: 0 });
		}
		solveAngularVelocity(joint, { targetSpeed: 0, error: 0, stepSeconds, maximumTorque: config.maxTorque, constrainTranslation: false, stiffness: 0 });
		return;
	}
	if (config.type === "relative") {
		const points = relativeConstraintPoints(joint);
		for (const axis of [
			[1, 0],
			[0, 1],
		] as IPhysics2DPoint[]) {
			const error = (points.second[0] - points.first[0] - points.offset[0]) * axis[0] + (points.second[1] - points.first[1] - points.offset[1]) * axis[1];
			solveLimitedLinearVelocityAtPoints(joint, { points, axis, error, stepSeconds, maximumForce: config.maxForce, targetSpeed: 0, stiffness: config.correctionScale });
		}
		solveAngularVelocity(joint, {
			targetSpeed: 0,
			error: angularError(joint, config.angularOffset),
			stepSeconds,
			maximumTorque: config.maxTorque,
			constrainTranslation: false,
			stiffness: config.correctionScale,
		});
		return;
	}
	if (config.type === "target") {
		const points = relativeConstraintPoints(joint);
		const stiffness = frequencyStiffness(config.frequency, stepSeconds);
		for (const axis of [
			[1, 0],
			[0, 1],
		] as IPhysics2DPoint[]) {
			const error = (points.second[0] - points.first[0]) * axis[0] + (points.second[1] - points.first[1]) * axis[1];
			solveLimitedLinearVelocityAtPoints(joint, {
				points,
				axis,
				error,
				stepSeconds,
				maximumForce: config.maxForce,
				targetSpeed: 0,
				stiffness,
				damping: config.dampingRatio,
			});
		}
		return;
	}
	const axis = localConstraintAxis(joint, config.angle);
	const perpendicular: IPhysics2DPoint = [-axis[1], axis[0]];
	if (config.type === "slider") {
		if (config.useMotor) {
			solveLimitedLinearVelocityAtPoints(joint, {
				points: anchorPoints(joint),
				axis,
				error: 0,
				stepSeconds,
				maximumForce: config.maxMotorForce,
				targetSpeed: config.motorSpeed,
				stiffness: 0,
			});
		}
		if (config.useLimits) {
			const translation = anchoredTranslation(joint, axis);
			const speed = (() => {
				const points = anchorPoints(joint);
				const firstVelocity = pointVelocity(joint.first, arm(joint.first, points.first));
				const secondVelocity = pointVelocity(joint.second, joint.second ? arm(joint.second, points.second) : [0, 0]);
				return (secondVelocity[0] - firstVelocity[0]) * axis[0] + (secondVelocity[1] - firstVelocity[1]) * axis[1];
			})();
			if ((translation <= config.lowerTranslation && speed < 0) || (translation >= config.upperTranslation && speed > 0)) {
				solveLinearVelocity(
					joint,
					axis,
					translation < config.lowerTranslation ? translation - config.lowerTranslation : translation - config.upperTranslation,
					stepSeconds
				);
			}
		}
		solveLinearVelocity(joint, perpendicular, anchoredTranslation(joint, perpendicular), stepSeconds);
		solveAngularVelocity(joint, { targetSpeed: 0, error: angularError(joint, config.referenceAngle), stepSeconds, constrainTranslation: false });
		return;
	}
	if (config.useMotor) {
		solveAngularVelocity(joint, {
			targetSpeed: config.motorSpeed,
			error: 0,
			stepSeconds,
			maximumTorque: config.maxMotorTorque,
			constrainTranslation: false,
			stiffness: 0,
		});
	}
	const stiffness = frequencyStiffness(config.frequency, stepSeconds);
	solveLinearVelocity(joint, axis, anchoredTranslation(joint, axis), stepSeconds, stiffness, config.dampingRatio);
	solveLinearVelocity(joint, perpendicular, anchoredTranslation(joint, perpendicular), stepSeconds);
}

export function solvePhysics2DJointPosition(joint: IPhysics2DRuntimeJoint, stepSeconds: number): void {
	if (joint.broken || !joint.config.enabled) {
		return;
	}
	const config = joint.config;
	if (config.type === "distance") {
		const state = distanceState(joint, config);
		if (!state) {
			return;
		}
		if (config.distance <= MinimumConstraintLength && Math.abs(state.error) <= MinimumConstraintLength) {
			solvePointPosition(joint, stepSeconds);
		} else {
			solveLinearPosition(joint, state.axis, state.error, stepSeconds);
		}
		return;
	}
	if (config.type === "spring") {
		const state = distanceState(joint, config);
		if (state) {
			solveLinearPosition(joint, state.axis, state.error, stepSeconds, frequencyStiffness(config.frequency, stepSeconds));
		}
		return;
	}
	if (config.type === "friction" || config.type === "relative" || config.type === "target") {
		return;
	}
	if (config.type === "slider" || config.type === "wheel") {
		const axis = localConstraintAxis(joint, config.angle);
		const perpendicular: IPhysics2DPoint = [-axis[1], axis[0]];
		solveLinearPosition(joint, perpendicular, anchoredTranslation(joint, perpendicular), stepSeconds);
		if (config.type === "slider") {
			if (config.useLimits) {
				const translation = anchoredTranslation(joint, axis);
				if (translation < config.lowerTranslation) {
					solveLinearPosition(joint, axis, translation - config.lowerTranslation, stepSeconds);
				} else if (translation > config.upperTranslation) {
					solveLinearPosition(joint, axis, translation - config.upperTranslation, stepSeconds);
				}
			}
			solveAngularPosition(joint, angularError(joint, config.referenceAngle), stepSeconds);
		} else {
			solveLinearPosition(joint, axis, anchoredTranslation(joint, axis), stepSeconds, frequencyStiffness(config.frequency, stepSeconds));
		}
		return;
	}
	const stiffness = config.type === "fixed" ? frequencyStiffness(config.frequency, stepSeconds) : 1;
	const hingeLimitTarget =
		config.type === "hinge" && config.useLimits
			? angularError(joint, config.referenceAngle) < config.minAngle
				? config.minAngle
				: angularError(joint, config.referenceAngle) > config.maxAngle
					? config.maxAngle
					: null
			: null;
	solvePointPosition(joint, stepSeconds, stiffness);
	if (config.type === "fixed") {
		solveAngularPosition(joint, angularError(joint, config.referenceAngle), stepSeconds, stiffness);
		return;
	}
	if (hingeLimitTarget !== null) {
		solveAngularPosition(joint, angularError(joint, config.referenceAngle) - hingeLimitTarget, stepSeconds);
	}
}

/** Converts accumulated centimeter-space impulses into detached force/torque evidence. */
export function physics2DJointRuntimeState(joint: IPhysics2DRuntimeJoint): IPhysics2DJointRuntimeState {
	const seconds = Math.max(joint.lastStepSeconds, MinimumConstraintLength);
	return {
		active: true,
		id: joint.config.id,
		type: joint.config.type,
		revision: joint.config.revision,
		enabled: joint.config.enabled,
		connected: !!joint.second || joint.config.secondNodeId === undefined,
		broken: joint.broken,
		reactionForce: [joint.reactionLinearImpulse[0] / (100 * seconds), joint.reactionLinearImpulse[1] / (100 * seconds)],
		reactionTorque: joint.reactionAngularImpulse / (100 * seconds),
	};
}

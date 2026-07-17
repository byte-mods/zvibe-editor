import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Scene } from "@babylonjs/core/scene";

import "./input-actions";

const observers = new WeakMap<Scene, any>();
const wheelCompressions = new WeakMap<Scene, Map<string, Map<string, number>>>();

function vehicles(scene: Scene): any[] {
	return Array.isArray(scene.metadata?.babylonEditorVehicles) ? scene.metadata.babylonEditorVehicles : [];
}

function isPhysicsMesh(node: any): node is AbstractMesh & { physicsAggregate: any } {
	return !!node?.physicsAggregate && typeof node.getDirection === "function" && typeof node.getAbsolutePosition === "function";
}

function getInput(scene: Scene, vehicle: any): { throttle: number; steering: number; brake: number } {
	const input = scene.inputActions;
	if (!input || !vehicle.actionMapName) return { throttle: 0, steering: 0, brake: 0 };
	const value = (name: string | undefined): number => (name ? input.getValue(vehicle.actionMapName, name) : 0);
	return {
		throttle: Math.max(-1, Math.min(1, value(vehicle.accelerateActionName) - value(vehicle.reverseActionName))),
		steering: Math.max(-1, Math.min(1, value(vehicle.rightActionName) - value(vehicle.leftActionName))),
		brake: Math.max(0, Math.min(1, value(vehicle.brakeActionName))),
	};
}

function applyWheelSuspension(scene: Scene, vehicle: any, chassis: any, body: any, forward: Vector3, right: Vector3, input: any, deltaSeconds: number): boolean {
	if (!Array.isArray(vehicle.wheels) || !vehicle.wheels.length) return false;
	const physics = scene.getPhysicsEngine() as any;
	if (!physics?.raycast) return false;
	const up = chassis.getDirection(Vector3.Up()).normalize();
	const world = chassis.getWorldMatrix();
	const mass = body.getMassProperties?.().mass ?? 1;
	const drivenCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.driven).length);
	const brakeCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.brake).length);
	let sceneCompressions = wheelCompressions.get(scene);
	if (!sceneCompressions) wheelCompressions.set(scene, (sceneCompressions = new Map()));
	let compressions = sceneCompressions.get(vehicle.id);
	if (!compressions) sceneCompressions.set(vehicle.id, (compressions = new Map()));
	for (const wheel of vehicle.wheels) {
		const mount = Vector3.TransformCoordinates(Vector3.FromArray(wheel.connectionPoint), world);
		const rayLength = wheel.suspensionRestLength + wheel.maxTravel + wheel.radius;
		const result = physics.raycast(mount, mount.subtract(up.scale(rayLength)), { ignoreBody: body });
		if (!result?.hasHit) {
			compressions.set(wheel.id, 0);
			continue;
		}
		const suspensionLength = Math.max(0, result.hitDistance - wheel.radius);
		const compression = Math.max(0, Math.min(wheel.suspensionRestLength + wheel.maxTravel, wheel.suspensionRestLength - suspensionLength));
		const contact = result.hitPointWorld ?? result.hitPoint;
		const compressionVelocity = (compression - (compressions.get(wheel.id) ?? 0)) / Math.max(deltaSeconds, 1 / 120);
		const suspensionForce = Math.max(0, wheel.springStrength * compression + wheel.damping * compressionVelocity);
		compressions.set(wheel.id, compression);
		if (suspensionForce) body.applyForce?.(up.scale(suspensionForce), mount);
		const steerAngle = wheel.steering ? input.steering * (vehicle.maxSteerAngle ?? 0.55) : 0;
		const wheelForward = steerAngle ? Vector3.TransformNormal(forward, Matrix.RotationAxis(up, steerAngle)).normalize() : forward;
		if (wheel.driven && input.throttle) body.applyForce?.(wheelForward.scale(((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount), contact);
		const velocity = body.getLinearVelocity?.() ?? Vector3.Zero();
		const lateralSpeed = Vector3.Dot(velocity, right);
		if (Math.abs(lateralSpeed) > 0.001)
			body.applyForce?.(right.scale((-lateralSpeed * mass * (vehicle.lateralGrip ?? 12)) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length), contact);
		if (wheel.brake && input.brake > 0 && velocity.lengthSquared() > 0.001)
			body.applyForce?.(velocity.normalize().scale((-(vehicle.maxBrakeForce ?? 35000) * input.brake) / brakeCount), contact);
	}
	return true;
}

function applyVehicle(scene: Scene, vehicle: any, deltaSeconds: number): void {
	if (!vehicle.enabled) return;
	const chassis = scene.getNodeById(vehicle.chassisNodeId);
	if (!isPhysicsMesh(chassis)) return;
	const body = chassis.physicsAggregate.body as any;
	if (body.getMotionType?.() !== PhysicsMotionType.DYNAMIC) return;
	const velocity = body.getLinearVelocity?.();
	if (!velocity) return;
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
	if (applyWheelSuspension(scene, vehicle, chassis, body, forward, right, input, deltaSeconds)) return;
	if (canAccelerate && input.throttle)
		body.applyForce?.(steeredForward.scale((vehicle.maxEngineForce ?? 25000) * input.throttle), position.add(forward.scale(vehicle.wheelBase ?? 180)));
	if (Math.abs(lateralSpeed) > 0.001) body.applyForce?.(right.scale((-lateralSpeed * mass * (vehicle.lateralGrip ?? 12)) / Math.max(deltaSeconds, 1 / 120)), position);
	if (input.brake > 0 && velocity.lengthSquared() > 0.001) body.applyForce?.(velocity.normalize().scale(-(vehicle.maxBrakeForce ?? 35000) * input.brake), position);
}

/** Attaches persisted arcade-vehicle chassis controllers after physics and input actions load. */
export function configureVehicles(scene: Scene): void {
	if (observers.has(scene) || !vehicles(scene).length) return;
	observers.set(
		scene,
		scene.onBeforePhysicsObservable.add(() => {
			const deltaSeconds = Math.min(Math.max((scene.getPhysicsEngine() as any)?.getTimeStep?.() ?? scene.getEngine().getDeltaTime() / 1000, 0), 1 / 30);
			if (!deltaSeconds) return;
			vehicles(scene).forEach((vehicle) => applyVehicle(scene, vehicle, deltaSeconds));
		})
	);
}

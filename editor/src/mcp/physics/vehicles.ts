import { Matrix, PhysicsMotionType, Scene, Tools, Vector3 } from "babylonjs";

import { isAbstractMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";

const observers = new WeakMap<Scene, any>();
const manualInputs = new WeakMap<Scene, Map<string, { throttle: number; steering: number; brake: number }>>();
const wheelStates = new WeakMap<Scene, Map<string, Map<string, { grounded: boolean; compression: number; contactPoint: number[] | null }>>>();

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

function getVehicle(scene: Scene, id: string): any {
	const vehicle = vehicles(scene).find((candidate) => candidate.id === id);
	if (!vehicle) {
		throw new Error(`Vehicle "${id}" was not found.`);
	}
	return vehicle;
}

function getInput(scene: Scene, vehicle: any): { throttle: number; steering: number; brake: number } {
	const manual = manualInputs.get(scene)?.get(vehicle.id);
	if (manual) {
		return manual;
	}
	const input = (scene as any).inputActions;
	if (!input || !vehicle.actionMapName) {
		return { throttle: 0, steering: 0, brake: 0 };
	}
	const value = (name: string | undefined): number => (name ? input.getValue(vehicle.actionMapName, name) : 0);
	return {
		throttle: Math.max(-1, Math.min(1, value(vehicle.accelerateActionName) - value(vehicle.reverseActionName))),
		steering: Math.max(-1, Math.min(1, value(vehicle.rightActionName) - value(vehicle.leftActionName))),
		brake: Math.max(0, Math.min(1, value(vehicle.brakeActionName))),
	};
}

export function createDefaultVehicleWheels(): any[] {
	return [
		{
			id: "front-left",
			name: "Front Left",
			connectionPoint: [-60, -40, 90],
			radius: 35,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: true,
			driven: true,
			brake: true,
		},
		{
			id: "front-right",
			name: "Front Right",
			connectionPoint: [60, -40, 90],
			radius: 35,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: true,
			driven: true,
			brake: true,
		},
		{
			id: "rear-left",
			name: "Rear Left",
			connectionPoint: [-60, -40, -90],
			radius: 35,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: false,
			driven: true,
			brake: true,
		},
		{
			id: "rear-right",
			name: "Rear Right",
			connectionPoint: [60, -40, -90],
			radius: 35,
			suspensionRestLength: 40,
			maxTravel: 20,
			springStrength: 10000,
			damping: 1000,
			steering: false,
			driven: true,
			brake: true,
		},
	];
}

function validateWheels(value: unknown): asserts value is any[] {
	if (!Array.isArray(value) || value.length < 2 || value.length > 16) {
		throw new Error("Vehicle wheels must contain from 2 through 16 entries.");
	}
	const ids = new Set<string>();
	for (const wheel of value) {
		if (!wheel?.id?.trim() || ids.has(wheel.id)) {
			throw new Error("Every vehicle wheel requires a unique non-empty id.");
		}
		ids.add(wheel.id);
		if (!Array.isArray(wheel.connectionPoint) || wheel.connectionPoint.length !== 3 || !wheel.connectionPoint.every(Number.isFinite)) {
			throw new Error(`Vehicle wheel "${wheel.id}" requires a finite local connectionPoint [x,y,z].`);
		}
		for (const [name, number, minimum, maximum] of [
			["radius", wheel.radius, 1, 1000],
			["suspensionRestLength", wheel.suspensionRestLength, 1, 2000],
			["maxTravel", wheel.maxTravel, 0, 1000],
			["springStrength", wheel.springStrength, 0, 1000000],
			["damping", wheel.damping, 0, 100000],
		] as Array<[string, number, number, number]>) {
			clamp(number, minimum, maximum, `${wheel.id}.${name}`);
		}
	}
}

function applyWheelSuspension(scene: Scene, vehicle: any, chassis: any, body: any, forward: Vector3, right: Vector3, input: any, deltaSeconds: number): boolean {
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
	const up = chassis.getDirection(Vector3.Up()).normalize();
	const world = chassis.getWorldMatrix();
	const mass = body.getMassProperties?.().mass ?? 1;
	const drivenCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.driven).length);
	const brakeCount = Math.max(1, vehicle.wheels.filter((wheel: any) => wheel.brake).length);
	for (const wheel of vehicle.wheels) {
		const mount = Vector3.TransformCoordinates(Vector3.FromArray(wheel.connectionPoint), world);
		const rayLength = wheel.suspensionRestLength + wheel.maxTravel + wheel.radius;
		const result = physics.raycast(mount, mount.subtract(up.scale(rayLength)), { ignoreBody: body });
		const previous = states.get(wheel.id) ?? { grounded: false, compression: 0, contactPoint: null };
		if (!result?.hasHit) {
			states.set(wheel.id, { grounded: false, compression: 0, contactPoint: null });
			continue;
		}
		const suspensionLength = Math.max(0, result.hitDistance - wheel.radius);
		const compression = Math.max(0, Math.min(wheel.suspensionRestLength + wheel.maxTravel, wheel.suspensionRestLength - suspensionLength));
		const compressionVelocity = (compression - previous.compression) / Math.max(deltaSeconds, 1 / 120);
		const suspensionForce = Math.max(0, wheel.springStrength * compression + wheel.damping * compressionVelocity);
		const contact = result.hitPointWorld ?? result.hitPoint;
		if (suspensionForce) {
			body.applyForce?.(up.scale(suspensionForce), mount);
		}
		const steerAngle = wheel.steering ? input.steering * (vehicle.maxSteerAngle ?? 0.55) : 0;
		const wheelForward = steerAngle ? Vector3.TransformNormal(forward, Matrix.RotationAxis(up, steerAngle)).normalize() : forward;
		if (wheel.driven && input.throttle) {
			body.applyForce?.(wheelForward.scale(((vehicle.maxEngineForce ?? 25000) * input.throttle) / drivenCount), contact);
		}
		const velocity = body.getLinearVelocity?.() ?? Vector3.Zero();
		const lateralSpeed = Vector3.Dot(velocity, right);
		if (Math.abs(lateralSpeed) > 0.001) {
			body.applyForce?.(right.scale((-lateralSpeed * mass * (vehicle.lateralGrip ?? 12)) / Math.max(deltaSeconds, 1 / 120) / vehicle.wheels.length), contact);
		}
		if (wheel.brake && input.brake > 0 && velocity.lengthSquared() > 0.001) {
			body.applyForce?.(velocity.normalize().scale((-(vehicle.maxBrakeForce ?? 35000) * input.brake) / brakeCount), contact);
		}
		states.set(wheel.id, { grounded: true, compression, contactPoint: contact.asArray() });
	}
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
	if (applyWheelSuspension(scene, vehicle, chassis, body, forward, right, input, deltaSeconds)) {
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
	] as Array<[string, number, number, number]>) {
		clamp(value, minimum, maximum, name);
	}
	if (config.wheels !== undefined) {
		validateWheels(config.wheels);
	}
}

/** Restores editor-authored vehicle force controllers after a saved scene is loaded. */
export function restoreVehicles(scene: Scene): void {
	ensureVehicleController(scene);
}

export function listVehicles(scene: Scene): any {
	return {
		vehicles: structuredClone(vehicles(scene)).map((vehicle) => ({
			...vehicle,
			input: manualInputs.get(scene)?.get(vehicle.id) ?? null,
			active: !!scene.getNodeById(vehicle.chassisNodeId),
			wheelStates: Object.fromEntries(wheelStates.get(scene)?.get(vehicle.id) ?? []),
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
		actionMapName: data.actionMapName ?? null,
		accelerateActionName: data.accelerateActionName ?? "Accelerate",
		reverseActionName: data.reverseActionName ?? "Reverse",
		leftActionName: data.leftActionName ?? "Steer Left",
		rightActionName: data.rightActionName ?? "Steer Right",
		brakeActionName: data.brakeActionName ?? "Brake",
		wheels: data.wheels ?? createDefaultVehicleWheels(),
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

export function setVehicleWheels(scene: Scene, data: any, options: IMCPActionOptions): any {
	const vehicle = getVehicle(scene, data.id);
	validateWheels(data.wheels);
	vehicle.wheels = structuredClone(data.wheels);
	wheelStates.get(scene)?.delete(vehicle.id);
	options.editor.layout.inspector.forceUpdate();
	return { id: vehicle.id, wheels: structuredClone(vehicle.wheels) };
}

export function setVehicle(scene: Scene, data: any, options: IMCPActionOptions): any {
	const vehicle = getVehicle(scene, data.id);
	const update = { ...data };
	delete update.id;
	Object.assign(vehicle, update);
	if (typeof vehicle.name === "string") {
		vehicle.name = vehicle.name.trim();
	}
	validateConfiguration(scene, vehicle);
	ensureVehicleController(scene);
	options.editor.layout.inspector.forceUpdate();
	return structuredClone(vehicle);
}

export function deleteVehicle(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = vehicles(scene).findIndex((vehicle) => vehicle.id === data.id);
	if (index === -1) {
		throw new Error(`Vehicle "${data.id}" was not found.`);
	}
	vehicles(scene).splice(index, 1);
	manualInputs.get(scene)?.delete(data.id);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Overrides vehicle controls in the active preview; inputs are transient and are not saved with the scene. */
export function setVehicleInput(scene: Scene, data: any): any {
	getVehicle(scene, data.id);
	let inputs = manualInputs.get(scene);
	if (!inputs) {
		manualInputs.set(scene, (inputs = new Map()));
	}
	const input = {
		throttle: clamp(data.throttle ?? 0, -1, 1, "throttle"),
		steering: clamp(data.steering ?? 0, -1, 1, "steering"),
		brake: clamp(data.brake ?? 0, 0, 1, "brake"),
	};
	inputs.set(data.id, input);
	ensureVehicleController(scene);
	return { id: data.id, input };
}

import { PhysicsConstraint, PhysicsConstraintType, PhysicsMotionType, PhysicsShapeType, Scene, Tools, Vector3 } from "babylonjs";

import { isAbstractMesh } from "../../tools/guards/nodes";

import { IMCPActionOptions } from "../action";
import { resolveNode } from "../tools/resolve";
import { listVehicles, validateVehicles } from "./vehicles";
import { getPhysicsContactCapture } from "./contacts";
import { getPhysicsSimulationControl } from "./simulation";

const constraintTypes: Record<string, PhysicsConstraintType> = {
	ball: PhysicsConstraintType.BALL_AND_SOCKET,
	distance: PhysicsConstraintType.DISTANCE,
	hinge: PhysicsConstraintType.HINGE,
	slider: PhysicsConstraintType.SLIDER,
	lock: PhysicsConstraintType.LOCK,
	prismatic: PhysicsConstraintType.PRISMATIC,
};
const runtimeConstraints = new WeakMap<Scene, Map<string, PhysicsConstraint>>();

function configs(scene: Scene): any[] {
	scene.metadata ??= {};
	return (scene.metadata.babylonEditorPhysicsConstraints ??= []);
}
function runtime(scene: Scene): Map<string, PhysicsConstraint> {
	let map = runtimeConstraints.get(scene);
	if (!map) runtimeConstraints.set(scene, (map = new Map()));
	return map;
}
function vector(value: any, fallback: number[]): Vector3 {
	return Vector3.FromArray(value ?? fallback);
}
function createRuntimeConstraint(scene: Scene, config: any): PhysicsConstraint {
	const parent = resolveNode({ scene, nodeId: config.parentNodeId });
	const child = resolveNode({ scene, nodeId: config.childNodeId });
	if (!isAbstractMesh(parent) || !isAbstractMesh(child) || !parent.physicsAggregate || !child.physicsAggregate) {
		throw new Error("Both constraint nodes must be meshes with enabled physics bodies.");
	}
	const type = constraintTypes[config.type];
	if (type === undefined) throw new Error(`Unknown constraint type "${config.type}".`);
	const constraint = new PhysicsConstraint(
		type,
		{
			pivotA: vector(config.pivotA, [0, 0, 0]),
			pivotB: vector(config.pivotB, [0, 0, 0]),
			axisA: vector(config.axisA, [1, 0, 0]),
			axisB: vector(config.axisB, [1, 0, 0]),
			perpAxisA: vector(config.perpAxisA, [0, 1, 0]),
			perpAxisB: vector(config.perpAxisB, [0, 1, 0]),
			maxDistance: config.maxDistance,
			collision: config.collision ?? false,
		},
		scene
	);
	parent.physicsAggregate.body.addConstraint(child.physicsAggregate.body, constraint);
	return constraint;
}

/** Recreates serialized constraints after a scene's physics bodies are available. */
export function restorePhysicsConstraints(scene: Scene): void {
	for (const config of configs(scene)) {
		if (runtime(scene).has(config.id)) continue;
		try {
			runtime(scene).set(config.id, createRuntimeConstraint(scene, config));
		} catch (error) {
			console.warn(`Failed to restore physics constraint ${config.id}:`, error);
		}
	}
}

export function listPhysicsConstraints(scene: Scene): any {
	return { constraints: structuredClone(configs(scene)).map((config) => ({ ...config, active: runtime(scene).has(config.id) })) };
}

/** Reads a bounded live physics snapshot for debugging without mutating simulation state. */
export function getPhysicsSimulationState(scene: Scene): any {
	const bodies = scene.meshes
		.filter((mesh) => !!mesh.physicsAggregate)
		.map((mesh) => {
			mesh.computeWorldMatrix(true);
			const aggregate = mesh.physicsAggregate!;
			const body = aggregate.body as any;
			const linearVelocity = body.getLinearVelocity?.();
			const angularVelocity = body.getAngularVelocity?.();
			return {
				nodeId: mesh.id,
				name: mesh.name,
				motionType: body.getMotionType?.() ?? null,
				mass: body.getMassProperties?.().mass ?? null,
				shapeType: aggregate.shape?.type ?? null,
				position: mesh.getAbsolutePosition().asArray(),
				linearVelocity: linearVelocity?.asArray?.() ?? null,
				angularVelocity: angularVelocity?.asArray?.() ?? null,
			};
		});
	return {
		physicsEngineActive: !!scene.getPhysicsEngine(),
		bodies,
		constraints: structuredClone(configs(scene)).map((config) => ({
			id: config.id,
			type: config.type,
			parentNodeId: config.parentNodeId,
			childNodeId: config.childNodeId,
			active: runtime(scene).has(config.id),
		})),
		vehicles: listVehicles(scene).vehicles,
		contactCapture: getPhysicsContactCapture(scene),
		simulationControl: getPhysicsSimulationControl(scene),
		validation: validatePhysicsScene(scene),
	};
}

export function createPhysicsConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const config = {
		id: data.id ?? Tools.RandomId(),
		type: data.type,
		parentNodeId: data.parentNodeId,
		childNodeId: data.childNodeId,
		pivotA: data.pivotA ?? [0, 0, 0],
		pivotB: data.pivotB ?? [0, 0, 0],
		axisA: data.axisA ?? [1, 0, 0],
		axisB: data.axisB ?? [1, 0, 0],
		perpAxisA: data.perpAxisA ?? [0, 1, 0],
		perpAxisB: data.perpAxisB ?? [0, 1, 0],
		maxDistance: data.maxDistance,
		collision: data.collision ?? false,
	};
	if (configs(scene).some((value) => value.id === config.id)) throw new Error(`Physics constraint "${config.id}" already exists.`);
	const constraint = createRuntimeConstraint(scene, config);
	configs(scene).push(config);
	runtime(scene).set(config.id, constraint);
	options.editor.layout.inspector.forceUpdate();
	return { ...config, active: true };
}

export function deletePhysicsConstraint(scene: Scene, data: any, options: IMCPActionOptions): any {
	const index = configs(scene).findIndex((value) => value.id === data.id);
	if (index === -1) throw new Error(`Physics constraint "${data.id}" was not found.`);
	runtime(scene).get(data.id)?.dispose();
	runtime(scene).delete(data.id);
	configs(scene).splice(index, 1);
	options.editor.layout.inspector.forceUpdate();
	return { deleted: true, id: data.id };
}

/** Validates physics bodies and serialized constraints without changing the simulation. */
export function validatePhysicsScene(scene: Scene): any {
	const errors: string[] = [];
	const warnings: string[] = [];
	const bodies = scene.meshes.filter((mesh) => !!mesh.physicsAggregate);
	if (!scene.getPhysicsEngine()) warnings.push("No physics engine is active in the current scene preview.");
	if (!bodies.length) warnings.push("The scene has no enabled physics bodies.");
	for (const mesh of bodies) {
		const aggregate = mesh.physicsAggregate!;
		const motionType = aggregate.body.getMotionType();
		const mass = aggregate.body.getMassProperties().mass ?? 0;
		if (motionType === PhysicsMotionType.DYNAMIC && (!(mass > 0) || !Number.isFinite(mass))) errors.push(`Dynamic body "${mesh.name}" must have a positive finite mass.`);
		if (motionType === PhysicsMotionType.DYNAMIC && aggregate.shape.type === PhysicsShapeType.MESH)
			warnings.push(`Dynamic body "${mesh.name}" uses a mesh collision shape; prefer primitive or convex shapes for runtime performance.`);
	}
	for (const config of configs(scene)) {
		const parent = scene.getNodeById(config.parentNodeId);
		const child = scene.getNodeById(config.childNodeId);
		if (!parent || !child) {
			errors.push(`Constraint "${config.id}" references a missing node.`);
			continue;
		}
		if (parent === child) errors.push(`Constraint "${config.id}" cannot connect a node to itself.`);
		if (!isAbstractMesh(parent) || !isAbstractMesh(child) || !parent.physicsAggregate || !child.physicsAggregate)
			errors.push(`Constraint "${config.id}" requires physics bodies on both referenced meshes.`);
		if (!runtime(scene).has(config.id)) warnings.push(`Constraint "${config.id}" is saved but not active in the current preview.`);
	}
	const vehicleValidation = validateVehicles(scene);
	errors.push(...vehicleValidation.errors);
	warnings.push(...vehicleValidation.warnings);
	return {
		valid: errors.length === 0,
		errors,
		warnings,
		statistics: {
			physicsEngineActive: !!scene.getPhysicsEngine(),
			bodyCount: bodies.length,
			constraintCount: configs(scene).length,
			activeConstraintCount: runtime(scene).size,
			vehicleCount: listVehicles(scene).vehicles.length,
		},
	};
}

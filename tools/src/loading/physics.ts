import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Vector3, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate";
import { PhysicsConstraint } from "@babylonjs/core/Physics/v2/physicsConstraint";
import { PhysicsConstraintType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin";
import { Scene } from "@babylonjs/core/scene";

import { isInstancedMesh, isMesh } from "../tools/guards";
import { configureHybridPhysicsSolver } from "./physics-hybrid-solver";

/**
 * Parses and loads the physics aggregate data for the given mesh.
 * @param mesh defines the reference to the mesh object.
 */
export function configurePhysicsAggregate(transformNode: AbstractMesh) {
	const data = transformNode.metadata?.physicsAggregate;
	if (!data) {
		return;
	}

	let mesh: Mesh | undefined = undefined;
	if (isMesh(transformNode)) {
		mesh = transformNode;
	} else if (isInstancedMesh(transformNode)) {
		mesh = transformNode.sourceMesh;
	}

	const aggregate = new PhysicsAggregate(transformNode, data.shape.type, {
		mesh,
		mass: data.massProperties.mass,
	});

	aggregate.body.setMassProperties({
		mass: data.massProperties.mass,
		inertia: data.massProperties.inertia ? Vector3.FromArray(data.massProperties.inertia) : undefined,
		centerOfMass: data.massProperties.centerOfMass ? Vector3.FromArray(data.massProperties.centerOfMass) : undefined,
		inertiaOrientation: data.massProperties.inertiaOrientation ? Quaternion.FromArray(data.massProperties.inertiaOrientation) : undefined,
	});

	aggregate.shape.density = data.shape.density;
	aggregate.body.setMotionType(data.body.motionType);
	aggregate.shape.material = data.material;
	const filter = transformNode.metadata?.babylonEditorPhysicsCollisionFilter;
	if (filter?.group !== undefined) {
		aggregate.shape.filterMembershipMask = filter.group;
	}
	if (filter?.mask !== undefined) {
		aggregate.shape.filterCollideMask = filter.mask;
	}

	transformNode.physicsAggregate = aggregate;
	transformNode.metadata.physicsAggregate = undefined;
}

const constraintTypes: Record<string, PhysicsConstraintType> = {
	ball: PhysicsConstraintType.BALL_AND_SOCKET,
	distance: PhysicsConstraintType.DISTANCE,
	hinge: PhysicsConstraintType.HINGE,
	slider: PhysicsConstraintType.SLIDER,
	lock: PhysicsConstraintType.LOCK,
	prismatic: PhysicsConstraintType.PRISMATIC,
};

/** Recreates editor-authored Havok constraints after all mesh aggregates have been loaded. */
export function configurePhysicsConstraints(scene: Scene): void {
	configureHybridPhysicsSolver(scene);
	const constraints = scene.metadata?.babylonEditorPhysicsConstraints;
	if (!Array.isArray(constraints)) {
		return;
	}

	for (const config of constraints) {
		const parent = scene.getNodeById(config.parentNodeId) as AbstractMesh | null;
		const child = scene.getNodeById(config.childNodeId) as AbstractMesh | null;
		const type = constraintTypes[config.type];
		if (!parent?.physicsAggregate || !child?.physicsAggregate || type === undefined) {
			continue;
		}
		const vector = (value: number[] | undefined, fallback: number[]): Vector3 => Vector3.FromArray(value ?? fallback);
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
	}
}

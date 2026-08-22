import { PhysicsMotionType, Scene, Vector3 } from "babylonjs";

import { IPhysicsForceDebugVector } from "./force-visualization-types";

export interface IPhysicsForceBodySamplingState {
	previousLinearVelocities: Map<string, Vector3>;
	netForces: Map<string, Vector3>;
	sampleCount: number;
	lastDeltaSeconds: number | null;
}

export function createPhysicsForceBodySamplingState(): IPhysicsForceBodySamplingState {
	return { previousLinearVelocities: new Map(), netForces: new Map(), sampleCount: 0, lastDeltaSeconds: null };
}

function finiteVector(value: unknown): Vector3 | null {
	const vector = value as any;
	const result =
		vector instanceof Vector3
			? vector.clone()
			: Array.isArray(vector) && vector.length >= 3
				? Vector3.FromArray(vector)
				: vector && typeof vector === "object"
					? new Vector3(vector.x, vector.y, vector.z)
					: null;
	if (!result) {
		return null;
	}
	return [result.x, result.y, result.z].every(Number.isFinite) ? result : null;
}

function debugVector(input: {
	id: string;
	category: IPhysicsForceDebugVector["category"];
	label: string;
	mesh: any;
	origin: Vector3;
	vector: Vector3;
	unit: string;
	provenance: IPhysicsForceDebugVector["provenance"];
}): IPhysicsForceDebugVector {
	return {
		id: input.id,
		category: input.category,
		label: input.label,
		nodeId: input.mesh.id,
		nodeName: input.mesh.name,
		relatedNodeId: null,
		origin: input.origin.asArray() as [number, number, number],
		vector: input.vector.asArray() as [number, number, number],
		magnitude: input.vector.length(),
		unit: input.unit,
		provenance: input.provenance,
	};
}

/** Samples completed body motion only; it never advances physics or calls a body setter. */
export function samplePhysicsBodyNetForces(scene: Scene, state: IPhysicsForceBodySamplingState, deltaSeconds?: number): void {
	const resolvedDelta = deltaSeconds ?? (scene.getPhysicsEngine() as any)?.getTimeStep?.();
	const validDelta = typeof resolvedDelta === "number" && Number.isFinite(resolvedDelta) && resolvedDelta > 0 && resolvedDelta <= 1 ? resolvedDelta : null;
	const liveIds = new Set<string>();
	for (const mesh of scene.meshes) {
		const body = mesh.physicsAggregate?.body as any;
		const linearVelocity = finiteVector(body?.getLinearVelocity?.());
		if (!body || !linearVelocity) {
			continue;
		}
		liveIds.add(mesh.id);
		const previous = state.previousLinearVelocities.get(mesh.id);
		const mass = body.getMassProperties?.().mass;
		if (previous && validDelta && typeof mass === "number" && Number.isFinite(mass) && mass > 0) {
			state.netForces.set(mesh.id, linearVelocity.subtract(previous).scale(mass / validDelta));
		} else {
			// Never retain an earlier estimate when the current completed step cannot prove a valid derivative.
			state.netForces.delete(mesh.id);
		}
		state.previousLinearVelocities.set(mesh.id, linearVelocity);
	}
	for (const id of state.previousLinearVelocities.keys()) {
		if (!liveIds.has(id)) {
			state.previousLinearVelocities.delete(id);
			state.netForces.delete(id);
		}
	}
	state.sampleCount++;
	state.lastDeltaSeconds = validDelta;
}

/** Reads exact body vectors plus the explicitly derived net-force estimate. */
export function collectPhysicsBodyForceVectors(scene: Scene, state: IPhysicsForceBodySamplingState): IPhysicsForceDebugVector[] {
	const vectors: IPhysicsForceDebugVector[] = [];
	const gravity = finiteVector((scene.getPhysicsEngine() as any)?.gravity ?? scene.gravity) ?? Vector3.Zero();
	for (const mesh of scene.meshes) {
		const body = mesh.physicsAggregate?.body as any;
		if (!body) {
			continue;
		}
		mesh.computeWorldMatrix(true);
		const origin = mesh.getAbsolutePosition();
		const mass = body.getMassProperties?.().mass;
		if (body.getMotionType?.() === PhysicsMotionType.DYNAMIC && typeof mass === "number" && Number.isFinite(mass) && mass > 0) {
			vectors.push(
				debugVector({
					id: `${mesh.id}:gravity-force`,
					category: "gravity-force",
					label: "Gravity force",
					mesh,
					origin,
					vector: gravity.scale(mass),
					unit: "kg·cm/s²",
					provenance: "live",
				})
			);
		}
		const netForce = state.netForces.get(mesh.id);
		if (netForce) {
			vectors.push(
				debugVector({
					id: `${mesh.id}:net-force`,
					category: "net-force",
					label: "Derived net force",
					mesh,
					origin,
					vector: netForce,
					unit: "kg·cm/s²",
					provenance: "derived",
				})
			);
		}
		const linearVelocity = finiteVector(body.getLinearVelocity?.());
		if (linearVelocity) {
			vectors.push(
				debugVector({
					id: `${mesh.id}:linear-velocity`,
					category: "linear-velocity",
					label: "Linear velocity",
					mesh,
					origin,
					vector: linearVelocity,
					unit: "cm/s",
					provenance: "live",
				})
			);
		}
		const angularVelocity = finiteVector(body.getAngularVelocity?.());
		if (angularVelocity) {
			vectors.push(
				debugVector({
					id: `${mesh.id}:angular-velocity`,
					category: "angular-velocity",
					label: "Angular velocity",
					mesh,
					origin,
					vector: angularVelocity,
					unit: "rad/s",
					provenance: "live",
				})
			);
		}
	}
	return vectors;
}

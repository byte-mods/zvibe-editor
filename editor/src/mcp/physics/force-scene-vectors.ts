import { Scene, Vector3 } from "babylonjs";

import { getPhysicsContactEventsForScene } from "./contacts";
import { IPhysicsForceDebugVector } from "./force-visualization-types";

function finiteVector(value: unknown): Vector3 | null {
	if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
		return null;
	}
	return Vector3.FromArray(value);
}

function vector(input: {
	id: string;
	category: IPhysicsForceDebugVector["category"];
	label: string;
	nodeId: string | null;
	nodeName: string | null;
	relatedNodeId: string | null;
	origin: Vector3;
	value: Vector3;
	unit: string;
	provenance: IPhysicsForceDebugVector["provenance"];
}): IPhysicsForceDebugVector {
	return {
		id: input.id,
		category: input.category,
		label: input.label,
		nodeId: input.nodeId,
		nodeName: input.nodeName,
		relatedNodeId: input.relatedNodeId,
		origin: input.origin.asArray() as [number, number, number],
		vector: input.value.asArray() as [number, number, number],
		magnitude: input.value.length(),
		unit: input.unit,
		provenance: input.provenance,
	};
}

/** Converts only actually captured points/normals/impulses; missing engine evidence stays absent. */
export function collectPhysicsContactForceVectors(scene: Scene): IPhysicsForceDebugVector[] {
	const result: IPhysicsForceDebugVector[] = [];
	for (const event of getPhysicsContactEventsForScene(scene)) {
		const origin = finiteVector(event.point);
		const normal = finiteVector(event.normal);
		if (!origin || !normal || normal.lengthSquared() === 0) {
			continue;
		}
		normal.normalize();
		const prefix = `contact:${event.sequence}`;
		result.push(
			vector({
				id: prefix + ":normal",
				category: "contact-normal",
				label: "Contact normal",
				nodeId: event.colliderNodeId,
				nodeName: event.colliderName,
				relatedNodeId: event.collidedAgainstNodeId,
				origin,
				value: normal,
				unit: "direction",
				provenance: "captured",
			})
		);
		if (event.impulse !== null && Number.isFinite(event.impulse)) {
			result.push(
				vector({
					id: prefix + ":impulse",
					category: "contact-impulse",
					label: "Contact impulse",
					nodeId: event.colliderNodeId,
					nodeName: event.colliderName,
					relatedNodeId: event.collidedAgainstNodeId,
					origin,
					value: normal.scale(event.impulse),
					unit: "engine impulse",
					provenance: "captured",
				})
			);
		}
	}
	return result;
}

/** Visualizes authored joint frames and current separation without claiming unavailable reaction force data. */
export function collectPhysicsConstraintVectors(scene: Scene): IPhysicsForceDebugVector[] {
	const result: IPhysicsForceDebugVector[] = [];
	const constraints = Array.isArray(scene.metadata?.babylonEditorPhysicsConstraints) ? scene.metadata.babylonEditorPhysicsConstraints : [];
	for (const constraint of constraints.slice(0, 512)) {
		const parent = scene.getNodeById(constraint.parentNodeId) as any;
		const child = scene.getNodeById(constraint.childNodeId) as any;
		const pivotA = finiteVector(constraint.pivotA ?? [0, 0, 0]);
		const pivotB = finiteVector(constraint.pivotB ?? [0, 0, 0]);
		const axisA = finiteVector(constraint.axisA ?? [1, 0, 0]);
		if (!parent?.getWorldMatrix || !child?.getWorldMatrix || !pivotA || !pivotB || !axisA) {
			continue;
		}
		parent.computeWorldMatrix?.(true);
		child.computeWorldMatrix?.(true);
		const origin = Vector3.TransformCoordinates(pivotA, parent.getWorldMatrix());
		const other = Vector3.TransformCoordinates(pivotB, child.getWorldMatrix());
		const axis = Vector3.TransformNormal(axisA, parent.getWorldMatrix());
		if (axis.lengthSquared() > 0) {
			result.push(
				vector({
					id: `constraint:${constraint.id}:axis`,
					category: "constraint-axis",
					label: `${constraint.type} axis`,
					nodeId: parent.id,
					nodeName: parent.name,
					relatedNodeId: child.id,
					origin,
					value: axis.normalize(),
					unit: "direction",
					provenance: "authored",
				})
			);
		}
		result.push(
			vector({
				id: `constraint:${constraint.id}:separation`,
				category: "constraint-separation",
				label: `${constraint.type} separation`,
				nodeId: parent.id,
				nodeName: parent.name,
				relatedNodeId: child.id,
				origin,
				value: other.subtract(origin),
				unit: "cm",
				provenance: "live",
			})
		);
	}
	return result;
}

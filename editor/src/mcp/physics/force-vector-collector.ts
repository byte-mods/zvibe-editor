import { Scene } from "babylonjs";

import { collectPhysicsBodyForceVectors, IPhysicsForceBodySamplingState } from "./force-body-vectors";
import { collectPhysicsConstraintVectors, collectPhysicsContactForceVectors } from "./force-scene-vectors";
import { IPhysicsForceDebugVector, IPhysicsForceVisualizationSettings, PhysicsForceVectorCategory, physicsForceVectorCategories } from "./force-visualization-types";

export interface IPhysicsForceVectorQuery {
	categories?: PhysicsForceVectorCategory[];
	bodyNodeIds?: string[];
	offset?: number;
	limit?: number;
}

function matches(vector: IPhysicsForceDebugVector, categories: readonly PhysicsForceVectorCategory[], bodyNodeIds: ReadonlySet<string>): boolean {
	return (
		categories.includes(vector.category) &&
		(!bodyNodeIds.size || (!!vector.nodeId && bodyNodeIds.has(vector.nodeId)) || (!!vector.relatedNodeId && bodyNodeIds.has(vector.relatedNodeId)))
	);
}

function counts(vectors: readonly IPhysicsForceDebugVector[]): Partial<Record<PhysicsForceVectorCategory, number>> {
	const result: Partial<Record<PhysicsForceVectorCategory, number>> = {};
	for (const vector of vectors) {
		result[vector.category] = (result[vector.category] ?? 0) + 1;
	}
	return result;
}

/** Collects and deterministically bounds one exact read/render snapshot without retaining engine vectors. */
export function collectPhysicsForceVectors(
	scene: Scene,
	sampling: IPhysicsForceBodySamplingState,
	settings: IPhysicsForceVisualizationSettings,
	query: IPhysicsForceVectorQuery = {}
): {
	vectors: IPhysicsForceDebugVector[];
	displayedVectors: IPhysicsForceDebugVector[];
	page: { offset: number; limit: number; count: number; total: number; hasMore: boolean; nextOffset: number | null };
	availableVectorCount: number;
	truncatedVectorCount: number;
	visibleVectorCount: number;
	categoryCounts: Partial<Record<PhysicsForceVectorCategory, number>>;
} {
	const order = new Map(physicsForceVectorCategories.map((category, index) => [category, index]));
	const bodyNodeIds = new Set(settings.bodyNodeIds);
	const all = [...collectPhysicsBodyForceVectors(scene, sampling), ...collectPhysicsContactForceVectors(scene), ...collectPhysicsConstraintVectors(scene)]
		.filter((vector) => matches(vector, settings.categories, bodyNodeIds))
		.sort((left, right) => (order.get(left.category) ?? 0) - (order.get(right.category) ?? 0) || left.id.localeCompare(right.id));
	const displayedVectors = all.slice(0, settings.maximumVectors);
	const queryCategories = query.categories ?? settings.categories;
	const queryBodyNodeIds = new Set(query.bodyNodeIds ?? []);
	const filtered = displayedVectors.filter((vector) => matches(vector, queryCategories, queryBodyNodeIds));
	const offset = query.offset ?? 0;
	const limit = query.limit ?? 50;
	const vectors = filtered.slice(offset, offset + limit).map((vector) => structuredClone(vector));
	return {
		vectors,
		displayedVectors,
		page: {
			offset,
			limit,
			count: vectors.length,
			total: filtered.length,
			hasMore: offset + vectors.length < filtered.length,
			nextOffset: offset + vectors.length < filtered.length ? offset + vectors.length : null,
		},
		availableVectorCount: all.length,
		truncatedVectorCount: all.length - displayedVectors.length,
		visibleVectorCount: displayedVectors.filter((vector) => vector.magnitude > 0).length,
		categoryCounts: counts(displayedVectors),
	};
}

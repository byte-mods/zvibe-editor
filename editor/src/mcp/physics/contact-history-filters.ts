import { IPhysicsContactEvent, maximumPhysicsContactHistoryDurationMs, physicsContactEventTypes, PhysicsContactEventType } from "./contact-history-types";

const filterKeys = ["types", "bodyNodeIds", "fromMs", "toMs", "minimumImpulse", "maximumImpulse"];

/** Normalized inclusive query evaluated against at most 1,000 validated events. */
export interface IPhysicsContactHistoryFilter {
	types: PhysicsContactEventType[];
	bodyNodeIds: string[];
	fromMs: number;
	toMs: number;
	minimumImpulse: number | null;
	maximumImpulse: number | null;
}

/** Bounded evidence counts used by list/read tools and the replay Inspector. */
export interface IPhysicsContactHistorySummary {
	eventCount: number;
	startedCount: number;
	continuedCount: number;
	finishedCount: number;
	uniqueBodyCount: number;
	uniquePairCount: number;
	missingBodyIdentityCount: number;
	pointCount: number;
	normalCount: number;
	impulseCount: number;
	maximumImpulse: number | null;
	firstElapsedMs: number | null;
	lastElapsedMs: number | null;
}

/** Applies a caller-selected default while rejecting every non-finite explicit number. */
function finite(value: unknown, path: string, fallback: number): number {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${path} must be a finite number.`);
	}
	return value;
}

/** Validates the complete filter once so the O(n) event scan contains no coercion or hidden defaults. */
export function validatePhysicsContactHistoryFilter(value: unknown = {}, durationMs = maximumPhysicsContactHistoryDurationMs): IPhysicsContactHistoryFilter {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Physics contact history filter must be an object.");
	}
	if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > maximumPhysicsContactHistoryDurationMs) {
		throw new Error(`Physics contact history filter duration must be from 0 through ${maximumPhysicsContactHistoryDurationMs}.`);
	}
	const source = value as Record<string, unknown>;
	const unknown = Object.keys(source).filter((key) => !filterKeys.includes(key));
	if (unknown.length) {
		throw new Error(`Physics contact history filter contains unknown fields: ${unknown.join(", ")}.`);
	}
	const types = source.types === undefined ? [...physicsContactEventTypes] : source.types;
	if (!Array.isArray(types) || types.length > physicsContactEventTypes.length || types.some((type) => !physicsContactEventTypes.includes(type))) {
		throw new Error("Physics contact history filter.types must contain only unique supported collision event types.");
	}
	if (new Set(types).size !== types.length) {
		throw new Error("Physics contact history filter.types must not contain duplicates.");
	}
	const bodyNodeIds = source.bodyNodeIds ?? [];
	if (!Array.isArray(bodyNodeIds) || bodyNodeIds.length > 64 || bodyNodeIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)) {
		throw new Error("Physics contact history filter.bodyNodeIds must contain at most 64 non-empty node ids of at most 256 characters.");
	}
	const normalizedBodyIds = bodyNodeIds.map((id) => id.trim());
	if (new Set(normalizedBodyIds).size !== normalizedBodyIds.length) {
		throw new Error("Physics contact history filter.bodyNodeIds must not contain duplicates.");
	}
	const fromMs = finite(source.fromMs, "Physics contact history filter.fromMs", 0);
	const toMs = finite(source.toMs, "Physics contact history filter.toMs", durationMs);
	if (fromMs < 0 || toMs > durationMs || fromMs > toMs) {
		throw new Error("Physics contact history filter time range must be ordered and inside the history duration.");
	}
	const minimumImpulse =
		source.minimumImpulse === null || source.minimumImpulse === undefined ? null : finite(source.minimumImpulse, "Physics contact history filter.minimumImpulse", 0);
	const maximumImpulse =
		source.maximumImpulse === null || source.maximumImpulse === undefined ? null : finite(source.maximumImpulse, "Physics contact history filter.maximumImpulse", 0);
	if (minimumImpulse !== null && maximumImpulse !== null && minimumImpulse > maximumImpulse) {
		throw new Error("Physics contact history filter impulse range must be ordered.");
	}
	return { types: types as PhysicsContactEventType[], bodyNodeIds: normalizedBodyIds, fromMs, toMs, minimumImpulse, maximumImpulse };
}

/** Applies inclusive time/impulse bounds and matches either stable body side without changing event order. */
export function filterPhysicsContactHistoryEvents(events: readonly IPhysicsContactEvent[], filter: IPhysicsContactHistoryFilter): IPhysicsContactEvent[] {
	const types = new Set(filter.types);
	const bodyNodeIds = new Set(filter.bodyNodeIds);
	return events
		.filter((event) => {
			if (!types.has(event.type) || event.elapsedMs < filter.fromMs || event.elapsedMs > filter.toMs) {
				return false;
			}
			if (bodyNodeIds.size && !bodyNodeIds.has(event.colliderNodeId ?? "") && !bodyNodeIds.has(event.collidedAgainstNodeId ?? "")) {
				return false;
			}
			if ((filter.minimumImpulse !== null || filter.maximumImpulse !== null) && event.impulse === null) {
				return false;
			}
			return (filter.minimumImpulse === null || event.impulse! >= filter.minimumImpulse) && (filter.maximumImpulse === null || event.impulse! <= filter.maximumImpulse);
		})
		.map((event) => ({ ...event, point: event.point ? [...event.point] : null, normal: event.normal ? [...event.normal] : null }));
}

/** Summarizes only exact recorded evidence; missing body ids and impulses remain explicit. */
export function summarizePhysicsContactHistoryEvents(events: readonly IPhysicsContactEvent[]): IPhysicsContactHistorySummary {
	const bodies = new Set<string>();
	const pairs = new Set<string>();
	let missingBodyIdentityCount = 0;
	let startedCount = 0;
	let continuedCount = 0;
	let finishedCount = 0;
	let pointCount = 0;
	let normalCount = 0;
	let impulseCount = 0;
	let maximumImpulse: number | null = null;
	for (const event of events) {
		if (event.type === "COLLISION_STARTED") {
			startedCount++;
		} else if (event.type === "COLLISION_CONTINUED") {
			continuedCount++;
		} else {
			finishedCount++;
		}
		const first = event.colliderNodeId ? `${event.colliderNodeId}:${event.colliderIndex}` : null;
		const second = event.collidedAgainstNodeId ? `${event.collidedAgainstNodeId}:${event.collidedAgainstIndex}` : null;
		if (first) {
			bodies.add(first);
		}
		if (second) {
			bodies.add(second);
		}
		if (first && second) {
			pairs.add([first, second].sort().join("\u0000"));
		} else {
			missingBodyIdentityCount++;
		}
		if (event.point) {
			pointCount++;
		}
		if (event.normal) {
			normalCount++;
		}
		if (event.impulse !== null) {
			impulseCount++;
			maximumImpulse = maximumImpulse === null ? event.impulse : Math.max(maximumImpulse, event.impulse);
		}
	}
	return {
		eventCount: events.length,
		startedCount,
		continuedCount,
		finishedCount,
		uniqueBodyCount: bodies.size,
		uniquePairCount: pairs.size,
		missingBodyIdentityCount,
		pointCount,
		normalCount,
		impulseCount,
		maximumImpulse,
		firstElapsedMs: events[0]?.elapsedMs ?? null,
		lastElapsedMs: events.at(-1)?.elapsedMs ?? null,
	};
}

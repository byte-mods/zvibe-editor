import { describe, expect, test } from "vitest";

import { filterPhysicsContactHistoryEvents, summarizePhysicsContactHistoryEvents, validatePhysicsContactHistoryFilter } from "../../src/mcp/physics/contact-history-filters";
import { IPhysicsContactEvent } from "../../src/mcp/physics/contact-history-types";

function event(sequence: number, elapsedMs: number, type: IPhysicsContactEvent["type"], first: string | null, second: string | null, impulse: number | null): IPhysicsContactEvent {
	return {
		sequence,
		elapsedMs,
		type,
		colliderNodeId: first,
		colliderName: first,
		colliderIndex: 0,
		collidedAgainstNodeId: second,
		collidedAgainstName: second,
		collidedAgainstIndex: second === "body-b" ? 2 : 0,
		point: sequence === 1 ? [1, 2, 3] : null,
		normal: sequence === 1 ? [0, 1, 0] : null,
		distance: null,
		impulse,
	};
}

const events = [
	event(1, 10, "COLLISION_STARTED", "body-a", "body-b", 5),
	event(2, 20, "COLLISION_CONTINUED", "body-b", "body-a", 10),
	event(3, 30, "COLLISION_FINISHED", "body-c", null, null),
];

describe("mcp/physics contact history filters", () => {
	test("combines type, either-body, inclusive time, and impulse filters without mutating source events", () => {
		const filter = validatePhysicsContactHistoryFilter(
			{ types: ["COLLISION_STARTED", "COLLISION_CONTINUED"], bodyNodeIds: ["body-a"], fromMs: 10, toMs: 20, minimumImpulse: 6, maximumImpulse: 10 },
			30
		);
		const result = filterPhysicsContactHistoryEvents(events, filter);
		expect(result).toEqual([expect.objectContaining({ sequence: 2, colliderNodeId: "body-b", collidedAgainstNodeId: "body-a", impulse: 10 })]);
		result[0].colliderNodeId = "mutated";
		expect(events[1].colliderNodeId).toBe("body-b");
	});

	test("keeps missing impulses only when no impulse range is requested", () => {
		const unrestricted = filterPhysicsContactHistoryEvents(events, validatePhysicsContactHistoryFilter({}, 30));
		const ranged = filterPhysicsContactHistoryEvents(events, validatePhysicsContactHistoryFilter({ minimumImpulse: -100 }, 30));
		expect(unrestricted.map((value) => value.sequence)).toEqual([1, 2, 3]);
		expect(ranged.map((value) => value.sequence)).toEqual([1, 2]);
	});

	test("summarizes canonical pairs, distinct indexed bodies, missing identities, and exact evidence", () => {
		expect(summarizePhysicsContactHistoryEvents(events)).toEqual({
			eventCount: 3,
			startedCount: 1,
			continuedCount: 1,
			finishedCount: 1,
			uniqueBodyCount: 4,
			uniquePairCount: 2,
			missingBodyIdentityCount: 1,
			pointCount: 1,
			normalCount: 1,
			impulseCount: 2,
			maximumImpulse: 10,
			firstElapsedMs: 10,
			lastElapsedMs: 30,
		});
	});

	test("rejects unknown, duplicate, oversized, and inverted filter input", () => {
		expect(() => validatePhysicsContactHistoryFilter({ magic: true }, 30)).toThrow("unknown fields: magic");
		expect(() => validatePhysicsContactHistoryFilter({ types: ["COLLISION_STARTED", "COLLISION_STARTED"] }, 30)).toThrow("must not contain duplicates");
		expect(() => validatePhysicsContactHistoryFilter({ bodyNodeIds: ["body-a", " body-a "] }, 30)).toThrow("must not contain duplicates");
		expect(() => validatePhysicsContactHistoryFilter({ fromMs: 20, toMs: 10 }, 30)).toThrow("time range must be ordered");
		expect(() => validatePhysicsContactHistoryFilter({ minimumImpulse: 2, maximumImpulse: 1 }, 30)).toThrow("impulse range must be ordered");
	});
});

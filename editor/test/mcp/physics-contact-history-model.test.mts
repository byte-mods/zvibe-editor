import { describe, expect, test } from "vitest";

import { validatePhysicsContactHistoryAsset } from "../../src/mcp/physics/contact-history-model";
import { maximumPhysicsContactHistoryDurationMs, physicsContactHistoryAssetType } from "../../src/mcp/physics/contact-history-types";

function validAsset(): any {
	return {
		version: 1,
		type: physicsContactHistoryAssetType,
		id: "history-1",
		name: "Vehicle impact",
		revision: 1,
		createdAt: "2026-07-30T00:00:00.000Z",
		durationMs: 250,
		source: { target: "play", scenePath: "assets/main.scene", includeContinued: true, droppedEvents: 4, capturedBodyCount: 2, maxEvents: 8 },
		events: [
			{
				sequence: 4,
				elapsedMs: 100,
				type: "COLLISION_STARTED",
				colliderNodeId: "body-a",
				colliderName: "Body A",
				colliderIndex: 0,
				collidedAgainstNodeId: "body-b",
				collidedAgainstName: "Body B",
				collidedAgainstIndex: 0,
				point: [1, 2, 3],
				normal: [0, 1, 0],
				distance: -0.5,
				impulse: 12,
			},
			{
				sequence: 9,
				elapsedMs: 100,
				type: "COLLISION_CONTINUED",
				colliderNodeId: "body-a",
				colliderName: "",
				colliderIndex: 0,
				collidedAgainstNodeId: null,
				collidedAgainstName: null,
				collidedAgainstIndex: 2,
				point: null,
				normal: null,
				distance: null,
				impulse: null,
			},
		],
	};
}

describe("mcp/physics contact history model", () => {
	test("normalizes a bounded rolling history into detached data", () => {
		const source = validAsset();
		const asset = validatePhysicsContactHistoryAsset(source, "assets/impact.physicscontacts.json");
		expect(asset).toMatchObject({ id: "history-1", durationMs: 250, source: { target: "play", droppedEvents: 4 }, events: [{ sequence: 4 }, { sequence: 9 }] });
		source.events[0].point[0] = 999;
		expect(asset.events[0].point).toEqual([1, 2, 3]);
	});

	test("rejects unknown fields, malformed vectors, unsupported events, and contradictory capture policy", () => {
		const unknown = validAsset();
		unknown.extra = true;
		expect(() => validatePhysicsContactHistoryAsset(unknown)).toThrow("unknown fields: extra");

		const vector = validAsset();
		vector.events[0].point = [1, 2];
		expect(() => validatePhysicsContactHistoryAsset(vector)).toThrow("exact three-component finite vector");

		const eventType = validAsset();
		eventType.events[0].type = "CONTACT_MAGIC";
		expect(() => validatePhysicsContactHistoryAsset(eventType)).toThrow("COLLISION_STARTED");

		const policy = validAsset();
		policy.source.includeContinued = false;
		expect(() => validatePhysicsContactHistoryAsset(policy)).toThrow("contradicts source.includeContinued=false");
	});

	test("rejects non-monotonic sequences or times and events outside bounded duration", () => {
		const sequence = validAsset();
		sequence.events[1].sequence = 4;
		expect(() => validatePhysicsContactHistoryAsset(sequence)).toThrow("strictly increasing sequences");

		const time = validAsset();
		time.events[1].elapsedMs = 99;
		expect(() => validatePhysicsContactHistoryAsset(time)).toThrow("non-decreasing elapsed times");

		const outside = validAsset();
		outside.events[1].elapsedMs = 251;
		expect(() => validatePhysicsContactHistoryAsset(outside)).toThrow("inside the history duration");

		const duration = validAsset();
		duration.durationMs = maximumPhysicsContactHistoryDurationMs + 1;
		expect(() => validatePhysicsContactHistoryAsset(duration)).toThrow("durationMs must be from 0");
	});

	test("rejects invalid timestamps, non-finite values, event-count overflow, and source max mismatch", () => {
		const timestamp = validAsset();
		timestamp.createdAt = "2026-07-30";
		expect(() => validatePhysicsContactHistoryAsset(timestamp)).toThrow("exact ISO-8601 UTC timestamp");

		const numeric = validAsset();
		numeric.events[0].impulse = Number.POSITIVE_INFINITY;
		expect(() => validatePhysicsContactHistoryAsset(numeric)).toThrow("finite number");

		const overflow = validAsset();
		overflow.events = Array.from({ length: 1001 }, () => overflow.events[0]);
		expect(() => validatePhysicsContactHistoryAsset(overflow)).toThrow("at most 1000 events");

		const mismatch = validAsset();
		mismatch.source.maxEvents = 1;
		expect(() => validatePhysicsContactHistoryAsset(mismatch)).toThrow("exceeds source.maxEvents");
	});
});

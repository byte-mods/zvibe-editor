import { describe, expect, test } from "vitest";

import { formatSceneTestAssertion } from "../../src/mcp/testing/format";

describe("testing inspector compatibility", () => {
	test("formats every portable assertion kind without assuming a vector", () => {
		expect(formatSceneTestAssertion({ type: "node-exists", nodeId: "box", exists: true })).toBe("Node box exists = true");
		expect(formatSceneTestAssertion({ type: "node-enabled", nodeId: "box", equals: false })).toBe("Node box enabled = false");
		expect(formatSceneTestAssertion({ type: "node-position", nodeId: "box", equals: [1, 2, 3] })).toBe("Node box position = [1, 2, 3]");
		expect(formatSceneTestAssertion({ type: "node-property", nodeId: "box", path: "metadata.health", operator: "greater-than", expected: 0 })).toBe(
			"Node box.metadata.health greater-than 0"
		);
		expect(formatSceneTestAssertion({ type: "scene-count", collection: "nodes", operator: "greater-than-or-equal", expected: 1 })).toBe("nodes greater-than-or-equal 1");
	});
});

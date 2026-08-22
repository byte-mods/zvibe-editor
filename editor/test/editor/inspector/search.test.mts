import { createElement } from "react";

import { afterEach, describe, expect, test } from "vitest";

import { matchesInspectorSearch, setInspectorSearch } from "../../../src/editor/layout/inspector/fields/field";

function NestedField(_props: { label: string; property: string }): null {
	return null;
}

describe("Inspector field search", () => {
	afterEach(() => setInspectorSearch(""));

	test("matches normalized labels, property paths, tooltips, and nested field declarations", () => {
		setInspectorSearch("maximum distance");
		expect(matchesInspectorSearch("Maximum Distance", "maxDistance")).toBe(true);
		expect(matchesInspectorSearch("Minimum Distance", "minDistance")).toBe(false);

		setInspectorSearch("shadow bias");
		expect(matchesInspectorSearch(createElement("div", null, createElement(NestedField, { label: "Shadow Bias", property: "shadowGenerator.bias" })))).toBe(true);

		setInspectorSearch("world-space tooltip");
		expect(matchesInspectorSearch("Position", "worldPosition", "World space tooltip")).toBe(true);

		setInspectorSearch("");
		expect(matchesInspectorSearch()).toBe(true);
	});
});

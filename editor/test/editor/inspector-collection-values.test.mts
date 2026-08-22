import { describe, expect, test } from "vitest";

import { computeDefaultValuesForObject } from "../../src/editor/layout/inspector/script/tools";

describe("Inspector collection values", () => {
	test("clamps oversized authored arrays and pads required list items", () => {
		const script = { values: { damage: { value: [1, 2, 3] }, points: { value: [] } } };
		computeDefaultValuesForObject(script, [
			{ propertyKey: "damage", configuration: { type: "array", elementType: "number", maxItems: 2 } },
			{ propertyKey: "points", configuration: { type: "list", elementType: "vector2", minItems: 2, maxItems: 4, defaultItem: [1, 2] } },
		]);
		expect(script.values.damage.value).toEqual([1, 2]);
		expect(script.values.points.value).toEqual([
			[1, 2],
			[1, 2],
		]);
		expect(script.values.points.value[0]).not.toBe(script.values.points.value[1]);
	});
});

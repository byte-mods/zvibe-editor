import { describe, expect, test } from "vitest";

import { parseECSSystemQuickSearch, queryECSSystems } from "../../src/ecs/debugger";
import { createDefaultECSConfiguration } from "../../src/ecs/model";

function configuration() {
	const value = createDefaultECSConfiguration();
	value.systems.push(
		{
			id: "move",
			name: "Move Units",
			namespace: "Game.Combat.Movement",
			enabled: true,
			phase: "update",
			order: 0,
			query: { all: ["transform"], any: [], none: [] },
			reads: [],
			writes: [{ componentId: "transform", fieldId: "position" }],
			dependsOn: [],
			operations: [],
		},
		{
			id: "present",
			name: "Present Units",
			namespace: "Game.Presentation",
			enabled: false,
			phase: "late",
			order: 0,
			query: { all: ["transform"], any: [], none: [] },
			reads: [{ componentId: "transform", fieldId: "position" }],
			writes: [],
			dependsOn: [],
			operations: [],
		}
	);
	return value;
}

describe("ecs/debugger", () => {
	test("parses namespace and additional quick filters", () => {
		expect(parseECSSystemQuickSearch("units namespace:Game.Combat phase:update enabled:true writes:transform")).toEqual({
			terms: ["units"],
			namespaces: ["Game.Combat"],
			phases: ["update"],
			enabled: true,
			reads: [],
			writes: ["transform"],
			components: [],
		});
		expect(() => parseECSSystemQuickSearch("unknown:value")).toThrow("Unknown ECS Systems");
	});

	test("filters namespace prefixes and paginates deterministically", () => {
		const result: any = queryECSSystems(configuration(), { search: "namespace:Game component:transform enabled:true", limit: 1 });
		expect(result).toMatchObject({ total: 1, returned: 1, hasMore: false, availableNamespaces: ["Game.Combat.Movement", "Game.Presentation"] });
		expect(result.systems[0]).toMatchObject({ id: "move", namespace: "Game.Combat.Movement" });
	});
});

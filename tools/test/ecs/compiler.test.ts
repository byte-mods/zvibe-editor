import { describe, expect, test } from "vitest";

import { IBakedECSChunk } from "../../src/ecs/baker";
import { compileECSConfiguration, matchesCompiledECSQuery } from "../../src/ecs/compiler";
import { IECSConfiguration, IECSSystemDefinition, createDefaultECSConfiguration } from "../../src/ecs/model";

function configuration(): IECSConfiguration {
	const value = createDefaultECSConfiguration();
	value.componentTypes.push({
		id: "motion",
		name: "Motion",
		namespace: "Game.Entities",
		assembly: "game",
		builtIn: false,
		fields: [
			{ id: "position", name: "Position", type: "vec3", defaultValue: [0, 0, 0] },
			{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0] },
			{ id: "mass", name: "Mass", type: "f64", defaultValue: 1 },
			{ id: "alive", name: "Alive", type: "bool", defaultValue: true },
		],
	});
	return value;
}

function system(id: string, targetField = "position", order = 0): IECSSystemDefinition {
	return {
		id,
		name: id,
		namespace: "Game.Systems",
		enabled: true,
		phase: "update",
		order,
		query: { all: ["motion"], any: [], none: [] },
		reads: [],
		writes: [{ componentId: "motion", fieldId: targetField }],
		dependsOn: [],
		operations: [{ id: `${id}Operation`, kind: "add", target: { componentId: "motion", fieldId: targetField }, constant: 1, useDeltaTime: false }],
	};
}

describe("ecs/compiler", () => {
	test("compiles portable kernels and batches independent systems together", () => {
		const value = configuration();
		value.systems.push(system("move"), system("weigh", "mass"));
		const compiled = compileECSConfiguration(value);
		expect(compiled.backend).toBe("portable-typed-array");
		expect(compiled.scheduleHash).toMatch(/^[a-f0-9]{16}$/);
		expect(compiled.phases.update.batches).toEqual([{ index: 0, systemIds: ["move", "weigh"] }]);
		expect(compiled.diagnostics[0]).toContain("not Unity Burst LLVM/native");
		expect(Object.isFrozen(compiled)).toBe(true);
		expect(Object.isFrozen(compiled.systems.move.operations)).toBe(true);
	});

	test("serializes read/write conflicts while preserving explicit dependency order", () => {
		const value = configuration();
		const first = system("first", "mass", 10);
		const second = system("second", "mass", -10);
		first.dependsOn = ["second"];
		value.systems.push(first, second);
		const compiled = compileECSConfiguration(value);
		expect(compiled.phases.update.batches.map((batch) => batch.systemIds)).toEqual([["second"], ["first"]]);
	});

	test("rejects dependency cycles and dependencies on later phases", () => {
		const cyclic = configuration();
		const first = system("first");
		const second = system("second");
		first.dependsOn = ["second"];
		second.dependsOn = ["first"];
		cyclic.systems.push(first, second);
		expect(() => compileECSConfiguration(cyclic)).toThrow("dependency cycle");

		const later = configuration();
		const fixed = system("fixed");
		fixed.phase = "fixed";
		fixed.dependsOn = ["late"];
		const late = system("late");
		late.phase = "late";
		later.systems.push(fixed, late);
		expect(() => compileECSConfiguration(later)).toThrow("cannot depend on later");
	});

	test("requires accessed component presence and compile-time operation operands", () => {
		const missingQuery = configuration();
		const badQuery = system("badQuery");
		badQuery.query.all = [];
		missingQuery.systems.push(badQuery);
		expect(() => compileECSConfiguration(missingQuery)).toThrow("query.all");

		const missingConstant = configuration();
		const badConstant = system("badConstant");
		delete badConstant.operations[0].constant;
		missingConstant.systems.push(badConstant);
		expect(() => compileECSConfiguration(missingConstant)).toThrow("requires constant");

		const boolMath = configuration();
		boolMath.systems.push(system("boolMath", "alive"));
		expect(() => compileECSConfiguration(boolMath)).toThrow("boolean field");

		const unequal = configuration();
		const copy = system("copy");
		copy.reads = [{ componentId: "motion", fieldId: "mass" }];
		copy.operations = [
			{ id: "copyValue", kind: "copy", target: { componentId: "motion", fieldId: "position" }, source: { componentId: "motion", fieldId: "mass" }, useDeltaTime: false },
		];
		unequal.systems.push(copy);
		expect(() => compileECSConfiguration(unequal)).toThrow("equal lane counts");
	});

	test("matches all/any/none queries against archetype component sets", () => {
		const chunk = { componentIds: ["transform", "motion"] } as IBakedECSChunk;
		expect(matchesCompiledECSQuery(chunk, { all: ["motion"], any: ["transform"], none: [] })).toBe(true);
		expect(matchesCompiledECSQuery(chunk, { all: ["motion"], any: [], none: ["transform"] })).toBe(false);
		expect(matchesCompiledECSQuery(chunk, { all: ["missing"], any: [], none: [] })).toBe(false);
	});
});

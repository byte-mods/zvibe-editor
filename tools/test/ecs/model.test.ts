import { describe, expect, test } from "vitest";

import {
	createDefaultECSConfiguration,
	getECSTypeRegistration,
	getECSFieldArity,
	getSceneECSConfiguration,
	normalizeECSConfiguration,
	normalizeECSFieldValue,
	normalizeEntityComponentData,
	setSceneECSConfiguration,
	validateECSConfiguration,
} from "../../src/ecs/model";

describe("ecs/model", () => {
	test("creates deterministic bounded defaults with an immutable transform schema", () => {
		const first = createDefaultECSConfiguration();
		const second = createDefaultECSConfiguration();
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		expect(first.componentTypes[0]).toMatchObject({ id: "transform", builtIn: true });
		expect(first.sections).toEqual([{ id: "main", name: "Main", autoLoad: true, priority: 0 }]);
		expect(() => validateECSConfiguration(first)).not.toThrow();
	});

	test("validates scalar, boolean, and vector field values exactly", () => {
		expect(getECSFieldArity("f64")).toBe(1);
		expect(getECSFieldArity("vec3")).toBe(3);
		expect(normalizeECSFieldValue("u32", 42)).toBe(42);
		expect(normalizeECSFieldValue("bool", true)).toBe(true);
		expect(normalizeECSFieldValue("quat", [0, 0, 0, 1])).toEqual([0, 0, 0, 1]);
		expect(() => normalizeECSFieldValue("u32", -1)).toThrow("u32 range");
		expect(() => normalizeECSFieldValue("vec3", [1, 2])).toThrow("3 lanes");
		expect(() => normalizeECSFieldValue("f64", Number.NaN)).toThrow("finite number");
	});

	test("accepts a cross-referenced component and compiled-system authoring model", () => {
		const configuration = createDefaultECSConfiguration();
		configuration.componentTypes.push({
			id: "motion",
			name: "Motion",
			namespace: "Game.Entities",
			assembly: "game",
			builtIn: false,
			fields: [
				{ id: "position", name: "Position", type: "vec3", defaultValue: [0, 0, 0] },
				{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0] },
			],
		});
		configuration.systems.push({
			id: "integrate",
			name: "Integrate Motion",
			namespace: "Game.Simulation",
			enabled: true,
			phase: "fixed",
			order: 0,
			query: { all: ["motion"], any: [], none: [] },
			reads: [{ componentId: "motion", fieldId: "velocity" }],
			writes: [{ componentId: "motion", fieldId: "position" }],
			dependsOn: [],
			operations: [
				{
					id: "integratePosition",
					kind: "integrate",
					target: { componentId: "motion", fieldId: "position" },
					source: { componentId: "motion", fieldId: "velocity" },
					useDeltaTime: true,
				},
			],
		});
		expect(() => validateECSConfiguration(configuration)).not.toThrow();
	});

	test("rejects unknown fields, duplicate ids, stale references, and undeclared writes", () => {
		const unknown = createDefaultECSConfiguration() as any;
		unknown.extra = true;
		expect(() => validateECSConfiguration(unknown)).toThrow('unknown field "extra"');

		const duplicate = createDefaultECSConfiguration();
		duplicate.sections.push({ ...duplicate.sections[0] });
		expect(() => validateECSConfiguration(duplicate)).toThrow("duplicates");

		const invalidDefault = createDefaultECSConfiguration();
		invalidDefault.componentTypes.push({
			id: "bounded",
			name: "Bounded",
			namespace: "Game.Entities",
			assembly: "game",
			builtIn: false,
			fields: [{ id: "value", name: "Value", type: "f64", defaultValue: 2, maximum: 1 }],
		});
		expect(() => validateECSConfiguration(invalidDefault)).toThrow("inside its numeric bounds");

		const boundedBoolean = createDefaultECSConfiguration();
		boundedBoolean.componentTypes.push({
			id: "flags",
			name: "Flags",
			namespace: "Game.Entities",
			assembly: "game",
			builtIn: false,
			fields: [{ id: "active", name: "Active", type: "bool", defaultValue: true, minimum: 0 }],
		});
		expect(() => validateECSConfiguration(boundedBoolean)).toThrow("numeric bounds to a boolean");

		const stale = createDefaultECSConfiguration();
		stale.systems.push({
			id: "bad",
			name: "Bad",
			namespace: "Game.Systems",
			enabled: true,
			phase: "update",
			order: 0,
			query: { all: ["missing"], any: [], none: [] },
			reads: [],
			writes: [],
			dependsOn: [],
			operations: [],
		});
		expect(() => validateECSConfiguration(stale)).toThrow("unknown id");

		const undeclared = createDefaultECSConfiguration();
		undeclared.systems.push({
			id: "badWrite",
			name: "Bad Write",
			namespace: "Game.Systems",
			enabled: true,
			phase: "update",
			order: 0,
			query: { all: ["transform"], any: [], none: [] },
			reads: [],
			writes: [],
			dependsOn: [],
			operations: [{ id: "write", kind: "set", target: { componentId: "transform", fieldId: "position" }, constant: 1, useDeltaTime: false }],
		});
		expect(() => validateECSConfiguration(undeclared)).toThrow("declared in system.writes");
	});

	test("requires explicit current-version state instead of silently resetting malformed metadata", () => {
		expect(() => normalizeECSConfiguration({ version: 99 })).toThrow("Unsupported ECS configuration version");
		expect(() => normalizeECSConfiguration("bad")).toThrow("must be an object");
	});

	test("migrates version-1 configurations and resolves assembly-wide type registration", () => {
		const legacy: any = createDefaultECSConfiguration();
		legacy.version = 1;
		delete legacy.settings.showHiddenEntitiesInHierarchy;
		delete legacy.settings.hierarchyWorldMode;
		delete legacy.typeRegistrationPolicies;
		legacy.componentTypes.forEach((component: any) => {
			delete component.namespace;
			delete component.assembly;
		});
		const migrated = normalizeECSConfiguration(legacy);
		expect(migrated).toMatchObject({ version: 2, settings: { showHiddenEntitiesInHierarchy: false, hierarchyWorldMode: "combined" }, typeRegistrationPolicies: [] });
		expect(migrated.componentTypes[0]).toMatchObject({ namespace: "Zvibe.Entities", assembly: "babylonjs-editor-tools" });

		migrated.componentTypes.push({ id: "motion", name: "Motion", namespace: "Game.Entities", assembly: "game", builtIn: false, fields: [] });
		migrated.typeRegistrationPolicies.push({ assembly: "game", disableAutoRegistration: true, registeredTypeIds: [] });
		validateECSConfiguration(migrated);
		expect(getECSTypeRegistration(migrated)).toEqual([
			expect.objectContaining({ typeId: "transform", registered: true, reason: "built-in" }),
			expect.objectContaining({ typeId: "motion", registered: false, reason: "assembly-auto-registration-disabled" }),
		]);
		migrated.typeRegistrationPolicies[0].registeredTypeIds = ["motion"];
		expect(getECSTypeRegistration(migrated)[1]).toMatchObject({ registered: true, reason: "explicit" });
	});

	test("reads without persistence and writes only validated cloned configuration", () => {
		const host: any = {};
		const read = getSceneECSConfiguration(host, false);
		expect(host.metadata).toBeUndefined();
		read.revision = 4;
		const saved = setSceneECSConfiguration(host, read);
		expect(host.metadata.babylonEditorECS.revision).toBe(4);
		saved.settings.enabled = false;
		expect(host.metadata.babylonEditorECS.settings.enabled).toBe(true);
	});

	test("migrates legacy entity values and bounds malformed typed components", () => {
		expect(
			normalizeEntityComponentData({
				archetype: "  Unit  ",
				sectionId: "combat",
				values: { hp: 42, label: "bad" },
				components: { motion: { speed: 3, enabled: true, velocity: [1, 2, 3], bad: [1] }, "bad id": { x: 1 } },
			})
		).toEqual({
			version: 3,
			archetype: "Unit",
			sectionId: "combat",
			values: { hp: 42 },
			components: { motion: { speed: 3, enabled: true, velocity: [1, 2, 3] } },
			bakingEnabled: true,
			hiddenInHierarchy: false,
		});
	});
});

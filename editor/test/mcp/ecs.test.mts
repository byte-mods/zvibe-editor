import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene, TransformNode } from "babylonjs";

import {
	bakeECS,
	createECSComponentType,
	createECSSection,
	createECSSystem,
	deleteECSConfiguration,
	deleteECSComponentType,
	deleteECSTypeRegistrationPolicy,
	inspectECS,
	inspectECSTypeRegistry,
	playbackECSRuntimeCommands,
	queryECSEntities,
	queryECSHierarchy,
	queryECSSystemsWindow,
	queueECSRuntimeCommand,
	replaceECSConfiguration,
	setECSHierarchyPreferences,
	setECSTypeRegistrationPolicy,
	stepECSRuntime,
	validateECS,
} from "../../src/mcp/ecs/ecs";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

describe("mcp/ecs", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() }, entities: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		clearUndoRedo();
	});

	afterEach(() => {
		clearUndoRedo();
		scene.dispose();
		engine.dispose();
	});

	test("authors exact schemas with stale protection and undo/redo", () => {
		const initial = inspectECS(scene);
		const created = createECSComponentType(
			scene,
			{
				expectedRevision: initial.configuration.revision,
				expectedFingerprint: initial.fingerprint,
				component: {
					id: "motion",
					name: "Motion",
					fields: [
						{ id: "position", name: "Position", type: "vec3", defaultValue: [0, 0, 0] },
						{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0] },
					],
				},
			},
			options
		);
		expect(created).toMatchObject({ revision: 1, component: { id: "motion", builtIn: false } });
		expect(() => createECSSection(scene, { expectedRevision: 0, expectedFingerprint: initial.fingerprint, section: { id: "combat", name: "Combat" } }, options)).toThrow(
			"revision is stale"
		);
		undo();
		expect(inspectECS(scene).configuration.componentTypes.map((entry: any) => entry.id)).toEqual(["transform"]);
		redo();
		expect(inspectECS(scene).configuration.componentTypes.map((entry: any) => entry.id)).toEqual(["transform", "motion"]);
	});

	test("creates and deletes the scene ECS asset with runtime-safe undo and redo", () => {
		const initial = inspectECS(scene);
		expect(initial).toMatchObject({ authored: false, runtime: null });
		replaceECSConfiguration(
			scene,
			{ expectedRevision: initial.configuration.revision, expectedFingerprint: initial.fingerprint, configuration: initial.configuration },
			options
		);
		let current = inspectECS(scene);
		expect(current).toMatchObject({ authored: true, runtime: { status: "running" } });
		deleteECSConfiguration(scene, { expectedRevision: current.configuration.revision, expectedFingerprint: current.fingerprint, confirm: true }, options);
		expect(inspectECS(scene)).toMatchObject({ authored: false, runtime: null });
		undo();
		expect(inspectECS(scene)).toMatchObject({ authored: true, runtime: { status: "running" } });
		redo();
		expect(inspectECS(scene)).toMatchObject({ authored: false, runtime: null });
	});

	test("bakes, schedules, steps, queries, and structurally mutates the live world", async () => {
		let lease = inspectECS(scene);
		createECSComponentType(
			scene,
			{
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				component: {
					id: "motion",
					name: "Motion",
					fields: [
						{ id: "position", name: "Position", type: "vec3", defaultValue: [0, 0, 0] },
						{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0] },
					],
				},
			},
			options
		);
		lease = inspectECS(scene);
		createECSSection(
			scene,
			{ expectedRevision: lease.configuration.revision, expectedFingerprint: lease.fingerprint, section: { id: "combat", name: "Combat", autoLoad: true } },
			options
		);
		const node = new TransformNode("Unit", scene);
		node.id = "unit";
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "entity-unit",
						type: "entity",
						enabled: true,
						data: {
							version: 2,
							archetype: "Unit",
							sectionId: "combat",
							values: {},
							components: { motion: { position: [0, 0, 0], velocity: [1, 0, 0] } },
							bakingEnabled: true,
						},
					},
				],
			},
		};
		lease = inspectECS(scene);
		createECSSystem(
			scene,
			{
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				system: {
					id: "integrate",
					name: "Integrate",
					phase: "fixed",
					query: { all: ["motion"], any: [], none: [] },
					reads: [{ componentId: "motion", fieldId: "velocity" }],
					writes: [{ componentId: "motion", fieldId: "position" }],
					operations: [
						{
							id: "integratePosition",
							kind: "integrate",
							target: { componentId: "motion", fieldId: "position" },
							source: { componentId: "motion", fieldId: "velocity" },
							constant: 1,
							useDeltaTime: true,
						},
					],
				},
			},
			options
		);

		lease = inspectECS(scene);
		const baked = bakeECS(
			scene,
			{
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				expectedGeneration: lease.runtime.generation,
				mode: "incremental",
				includeValues: true,
			},
			options
		);
		expect(baked.runtime).toMatchObject({ entityCount: 1, activeEntityCount: 1 });
		expect(validateECS(scene)).toMatchObject({ valid: true, world: { entityCount: 1 } });

		const generation = inspectECS(scene).runtime.generation;
		const step = await stepECSRuntime(scene, { expectedGeneration: generation, expectedStatus: "running", deltaSeconds: 1 / 60, useWorkers: false }, options);
		expect(step.result.fixedSteps).toBe(1);
		const query = queryECSEntities(scene, { all: ["motion"], includeValues: true, limit: 10 });
		expect(query.entities[0].values["motion.position"][0]).toBeCloseTo(1 / 60);

		queueECSRuntimeCommand(scene, { expectedGeneration: generation, command: { kind: "instantiate-entity", sourceEntityId: "unit", entityId: "clone" } }, options);
		expect(playbackECSRuntimeCommands(scene, { expectedGeneration: generation }, options)).toMatchObject({ applied: 1, runtime: { entityCount: 2 } });
		expect(queryECSEntities(scene, { all: ["motion"], limit: 10 }).total).toBe(2);
		lease = inspectECS(scene);
		expect(() =>
			deleteECSComponentType(scene, { expectedRevision: lease.configuration.revision, expectedFingerprint: lease.fingerprint, componentId: "motion", confirm: true }, options)
		).toThrow("referenced by a system");
	});

	test("queries hidden authoring/runtime hierarchy under exact preferences and generation leases", () => {
		const hidden = new TransformNode("Hidden Unit", scene);
		hidden.id = "hidden-unit";
		hidden.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{
						id: "entity-hidden-unit",
						type: "entity",
						enabled: true,
						data: { version: 3, archetype: "Unit", sectionId: "main", values: {}, components: {}, bakingEnabled: true, hiddenInHierarchy: true },
					},
				],
			},
		};
		let lease = inspectECS(scene);
		replaceECSConfiguration(scene, { expectedRevision: lease.configuration.revision, expectedFingerprint: lease.fingerprint, configuration: lease.configuration }, options);
		lease = inspectECS(scene);
		expect(
			queryECSHierarchy(scene, {
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				expectedGeneration: lease.runtime.generation,
				world: "combined",
			})
		).toMatchObject({ total: 0, showHidden: false });
		expect(
			queryECSHierarchy(scene, {
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				expectedGeneration: lease.runtime.generation,
				world: "runtime",
				showHidden: true,
			})
		).toMatchObject({ total: 1, entities: [{ entityId: "hidden-unit", name: "Hidden Unit", hiddenInHierarchy: true, origin: "authoring", runtimePresent: true }] });
		expect(() =>
			queryECSHierarchy(scene, {
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				expectedGeneration: lease.runtime.generation + 1,
				world: "runtime",
			})
		).toThrow("generation is stale");
		setECSHierarchyPreferences(
			scene,
			{ expectedRevision: lease.configuration.revision, expectedFingerprint: lease.fingerprint, showHiddenEntitiesInHierarchy: true, hierarchyWorldMode: "runtime" },
			options
		);
		lease = inspectECS(scene);
		expect(lease.configuration.settings).toMatchObject({ showHiddenEntitiesInHierarchy: true, hierarchyWorldMode: "runtime" });
		expect(
			queryECSHierarchy(scene, {
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				expectedGeneration: lease.runtime.generation,
				world: "runtime",
			})
		).toMatchObject({ total: 1 });
	});

	test("filters Systems by namespace and enforces assembly-wide type registration atomically", () => {
		let lease = inspectECS(scene);
		createECSComponentType(
			scene,
			{
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				component: { id: "motion", name: "Motion", namespace: "Game.Entities", assembly: "game", fields: [] },
			},
			options
		);
		lease = inspectECS(scene);
		createECSSystem(
			scene,
			{
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				system: { id: "move", name: "Move", namespace: "Game.Combat.Movement", query: { all: ["motion"], any: [], none: [] } },
			},
			options
		);
		lease = inspectECS(scene);
		expect(
			queryECSSystemsWindow(scene, {
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				search: "namespace:Game.Combat phase:update component:motion enabled:true",
			})
		).toMatchObject({ total: 1, systems: [{ id: "move", namespace: "Game.Combat.Movement" }] });
		expect(() =>
			setECSTypeRegistrationPolicy(
				scene,
				{
					expectedRevision: lease.configuration.revision,
					expectedFingerprint: lease.fingerprint,
					policy: { assembly: "game", disableAutoRegistration: true, registeredTypeIds: [] },
				},
				options
			)
		).toThrow("references unregistered component");
		expect(inspectECS(scene).configuration.typeRegistrationPolicies).toEqual([]);
		const policy = setECSTypeRegistrationPolicy(
			scene,
			{
				expectedRevision: lease.configuration.revision,
				expectedFingerprint: lease.fingerprint,
				policy: { assembly: "game", disableAutoRegistration: true, registeredTypeIds: ["motion"] },
			},
			options
		);
		expect(policy.registry).toContainEqual(expect.objectContaining({ typeId: "motion", registered: true, reason: "explicit" }));
		lease = inspectECS(scene);
		expect(inspectECSTypeRegistry(scene, { assembly: "game", limit: 1 })).toMatchObject({ total: 1, returned: 1, types: [{ typeId: "motion", registered: true }] });
		deleteECSTypeRegistrationPolicy(
			scene,
			{ expectedRevision: lease.configuration.revision, expectedFingerprint: lease.fingerprint, assembly: "game", confirm: true },
			options
		);
		expect(inspectECSTypeRegistry(scene, { assembly: "game" }).types[0]).toMatchObject({ registered: true, reason: "automatic" });
	});
});

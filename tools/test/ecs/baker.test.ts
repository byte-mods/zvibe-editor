import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, test } from "vitest";

import { ECSBaker, createECSWorldSnapshot } from "../../src/ecs/baker";
import { IECSConfiguration, createDefaultECSConfiguration } from "../../src/ecs/model";

function createConfiguration(): IECSConfiguration {
	const configuration = createDefaultECSConfiguration();
	configuration.settings.chunkCapacity = 16;
	configuration.componentTypes.push({
		id: "motion",
		name: "Motion",
		namespace: "Game.Entities",
		assembly: "game",
		builtIn: false,
		fields: [
			{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0] },
			{ id: "mass", name: "Mass", type: "f64", defaultValue: 1, minimum: 0, maximum: 100 },
			{ id: "alive", name: "Alive", type: "bool", defaultValue: true },
		],
	});
	configuration.sections.push({ id: "combat", name: "Combat", autoLoad: false, priority: 10 });
	return configuration;
}

function addEntity(scene: Scene, id: string, archetype: string, sectionId = "main", values: Record<string, unknown> = {}): TransformNode {
	const node = new TransformNode(id, scene);
	node.id = id;
	node.metadata = {
		babylonEditorComponentStack: {
			version: 1,
			components: [
				{
					id: `entity-${id}`,
					type: "entity",
					enabled: true,
					data: {
						version: 2,
						archetype,
						sectionId,
						values: {},
						components: { motion: values },
						bakingEnabled: true,
					},
				},
			],
		},
	};
	return node;
}

function entityData(node: TransformNode): any {
	return node.metadata.babylonEditorComponentStack.components[0].data;
}

describe("ecs/baker", () => {
	test("bakes deterministic typed chunks with transform lanes, defaults, and exact source leases", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = addEntity(scene, "unit-1", "Unit", "main", { velocity: [1, 2, 3], mass: 4 });
		node.position.set(10, 20, 30);

		const first = new ECSBaker().bake(scene, createConfiguration(), { mode: "full" }).world;
		const second = new ECSBaker().bake(scene, createConfiguration(), { mode: "full" }).world;
		expect(createECSWorldSnapshot(first, { includeValues: true })).toEqual(createECSWorldSnapshot(second, { includeValues: true }));
		expect(first.entityCount).toBe(1);
		expect(first.activeEntityCount).toBe(1);
		expect(first.chunks[0].componentIds).toEqual(["motion", "transform"]);
		expect(first.chunks[0].columns["motion.mass"].values).toBeInstanceOf(Float64Array);
		expect(Array.from(first.chunks[0].columns["motion.mass"].values)).toEqual([4]);
		expect(first.chunks[0].columns["motion.velocity"].values).toBeInstanceOf(Float32Array);
		expect(Array.from(first.chunks[0].columns["motion.velocity"].values)).toEqual([1, 2, 3]);
		expect(first.chunks[0].columns["motion.alive"].values).toBeInstanceOf(Uint8Array);
		expect(Array.from(first.chunks[0].columns["motion.alive"].values)).toEqual([1]);
		expect(Array.from(first.chunks[0].columns["transform.position"].values)).toEqual([10, 20, 30]);
		expect(first.sourceLeases["unit-1"].sourceHash).toMatch(/^[a-f0-9]{16}$/);
	});

	test("rebuilds only affected buckets and reports changed, reused, and removed sources", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const unit = addEntity(scene, "unit", "Unit", "main", { mass: 1 });
		const prop = addEntity(scene, "prop", "Prop", "main", { mass: 2 });
		const baker = new ECSBaker();
		const initial = baker.bake(scene, createConfiguration(), { mode: "full" });
		const unitChunk = initial.world.chunks.find((chunk) => chunk.entityIds.includes("unit"))!;
		const propChunk = initial.world.chunks.find((chunk) => chunk.entityIds.includes("prop"))!;

		entityData(unit).components.motion.mass = 3;
		const updated = baker.bake(scene, createConfiguration(), { mode: "incremental", expectedGeneration: initial.world.generation });
		expect(updated.report.changedSourceIds).toEqual(["unit"]);
		expect(updated.report.reusedSourceIds).toEqual(["prop"]);
		expect(updated.world.chunks.find((chunk) => chunk.entityIds.includes("unit"))).not.toBe(unitChunk);
		expect(updated.world.chunks.find((chunk) => chunk.entityIds.includes("prop"))).toBe(propChunk);

		const staleLease = initial.world.sourceLeases.unit.sourceHash;
		expect(() => baker.bake(scene, createConfiguration(), { expectedSourceHashes: { unit: staleLease } })).toThrow("source lease changed");
		prop.metadata.babylonEditorComponentStack.components[0].enabled = false;
		const removed = baker.bake(scene, createConfiguration());
		expect(removed.report.removedSourceIds).toEqual(["prop"]);
		expect(removed.world.entityCount).toBe(1);
	});

	test("keeps unloaded sections baked and toggles active chunks without rebuilding storage", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		addEntity(scene, "main-unit", "Unit", "main", { mass: 1 });
		addEntity(scene, "combat-unit", "Unit", "combat", { mass: 2 });
		const baker = new ECSBaker();
		const baked = baker.bake(scene, createConfiguration()).world;
		const chunks = [...baked.chunks];
		expect(baked.entityCount).toBe(2);
		expect(baked.activeEntityCount).toBe(1);
		expect(baked.sections.find((section) => section.id === "combat")).toMatchObject({ loaded: false, entityCount: 1, activeEntityCount: 0 });
		expect(baker.setSectionLoaded("combat", false, baked.generation)).toBe(baked);

		const loaded = baker.setSectionLoaded("combat", true, baked.generation);
		expect(loaded.activeEntityCount).toBe(2);
		expect(loaded.chunks[0]).toBe(chunks[0]);
		expect(loaded.chunks[1]).toBe(chunks[1]);
		expect(() => baker.setSectionLoaded("missing", true)).toThrow("Unknown ECS section");
		expect(() => baker.setSectionLoaded("combat", false, baked.generation)).toThrow("generation changed");
	});

	test("splits archetype storage at configured capacity and paginates snapshots", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		for (let index = 0; index < 17; index++) {
			addEntity(scene, `unit-${String(index).padStart(2, "0")}`, "Unit", "main", { mass: index });
		}
		const world = new ECSBaker().bake(scene, createConfiguration()).world;
		expect(world.chunks.map((chunk) => chunk.count)).toEqual([16, 1]);
		const snapshot: any = createECSWorldSnapshot(world, { chunkOffset: 1, chunkLimit: 1, includeValues: true });
		expect(snapshot.pagination).toEqual({ offset: 1, limit: 1, returned: 1, total: 2, hasMore: false });
		expect(snapshot.chunks[0].columns["motion.mass"].values).toEqual([16]);
		expect(Object.keys(snapshot.sourceLeases)).toEqual(["unit-16"]);
		expect(snapshot.sourceLeases["unit-16"].sourceHash).toMatch(/^[a-f0-9]{16}$/);
	});

	test("rejects unknown sections, unknown fields, built-in authoring, and out-of-range values", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = addEntity(scene, "bad", "Unit", "missing", { mass: 1 });
		const baker = new ECSBaker();
		expect(() => baker.bake(scene, createConfiguration())).toThrow("unknown ECS section");

		entityData(node).sectionId = "main";
		entityData(node).components.motion.unknown = 1;
		expect(() => baker.bake(scene, createConfiguration())).toThrow("unknown field");
		delete entityData(node).components.motion.unknown;
		entityData(node).components.motion.mass = 101;
		expect(() => baker.bake(scene, createConfiguration())).toThrow("exceeds maximum");
		entityData(node).components.motion.mass = 1;
		entityData(node).components.transform = { position: [1, 2, 3] };
		expect(() => baker.bake(scene, createConfiguration())).toThrow("cannot author built-in");
	});

	test("forces a full rebuild when the validated configuration changes", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		addEntity(scene, "unit", "Unit", "main", { mass: 1 });
		const baker = new ECSBaker();
		const configuration = createConfiguration();
		const initial = baker.bake(scene, configuration);
		configuration.revision++;
		const rebuilt = baker.bake(scene, configuration, { mode: "incremental" });
		expect(rebuilt.report.fullRebuild).toBe(true);
		expect(rebuilt.world.chunks[0]).not.toBe(initial.world.chunks[0]);
		configuration.sections[0].name = "Mutated Outside";
		expect(baker.setSectionLoaded("main", false).sections.find((section) => section.id === "main")?.name).toBe("Main");
	});

	test("preserves authored hierarchy metadata and rejects unregistered authored types", () => {
		const scene = new Scene(new NullEngine());
		const parent = addEntity(scene, "parent", "Unit", "main", { mass: 1 });
		const child = addEntity(scene, "child", "Unit", "main", { mass: 2 });
		child.parent = parent;
		child.metadata.babylonEditorComponentStack.components[0].data.hiddenInHierarchy = true;
		const configuration = createConfiguration();
		const world = new ECSBaker().bake(scene, configuration).world;
		const chunk = world.chunks[0];
		const row = chunk.entityIds.indexOf("child");
		expect(chunk.entityNames[row]).toBe("child");
		expect(chunk.parentEntityIds[row]).toBe("parent");
		expect(chunk.hiddenInHierarchy[row]).toBe(true);
		expect(chunk.authoredEntities[row]).toBe(true);

		configuration.typeRegistrationPolicies = [{ assembly: "game", disableAutoRegistration: true, registeredTypeIds: [] }];
		expect(() => new ECSBaker().bake(scene, configuration)).toThrow('uses unregistered ECS component "motion"');
	});
});

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, test } from "vitest";

import { ECSRuntime, configureAuthoredECSRuntime, configureECSRuntime, disposeECSRuntime, getECSRuntime } from "../../src/ecs/runtime";
import { IECSConfiguration, createDefaultECSConfiguration } from "../../src/ecs/model";
import { supportsECSWorkers } from "../../src/ecs/worker";

function configuration(): IECSConfiguration {
	const value = createDefaultECSConfiguration();
	value.settings.fixedDeltaSeconds = 0.01;
	value.settings.maxCatchUpSteps = 2;
	value.settings.traceLimit = 16;
	value.componentTypes.push({
		id: "motion",
		name: "Motion",
		namespace: "Game.Entities",
		assembly: "game",
		builtIn: false,
		fields: [
			{ id: "position", name: "Position", type: "vec3", defaultValue: [0, 0, 0] },
			{ id: "velocity", name: "Velocity", type: "vec3", defaultValue: [0, 0, 0] },
			{ id: "mass", name: "Mass", type: "f64", defaultValue: 1, minimum: 0, maximum: 10 },
		],
	});
	value.sections.push({ id: "combat", name: "Combat", autoLoad: false, priority: 1 });
	value.systems.push(
		{
			id: "integrate",
			name: "Integrate",
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
					constant: 1,
					useDeltaTime: true,
				},
			],
		},
		{
			id: "gainMass",
			name: "Gain Mass",
			namespace: "Game.Simulation",
			enabled: true,
			phase: "update",
			order: 0,
			query: { all: ["motion"], any: [], none: [] },
			reads: [],
			writes: [{ componentId: "motion", fieldId: "mass" }],
			dependsOn: [],
			operations: [{ id: "addMass", kind: "add", target: { componentId: "motion", fieldId: "mass" }, constant: 2, useDeltaTime: false }],
		},
		{
			id: "clampMass",
			name: "Clamp Mass",
			namespace: "Game.Simulation",
			enabled: true,
			phase: "late",
			order: 0,
			query: { all: ["motion"], any: [], none: [] },
			reads: [],
			writes: [{ componentId: "motion", fieldId: "mass" }],
			dependsOn: [],
			operations: [{ id: "clampMassValue", kind: "clamp", target: { componentId: "motion", fieldId: "mass" }, minimum: 0, maximum: 4, useDeltaTime: false }],
		},
		{
			id: "syncTransform",
			name: "Sync Transform",
			namespace: "Game.Presentation",
			enabled: true,
			phase: "late",
			order: 1,
			query: { all: ["motion", "transform"], any: [], none: [] },
			reads: [{ componentId: "motion", fieldId: "position" }],
			writes: [{ componentId: "transform", fieldId: "position" }],
			dependsOn: [],
			operations: [
				{
					id: "copyPosition",
					kind: "copy",
					target: { componentId: "transform", fieldId: "position" },
					source: { componentId: "motion", fieldId: "position" },
					useDeltaTime: false,
				},
			],
		}
	);
	return value;
}

function addEntity(scene: Scene, id: string, sectionId = "main"): TransformNode {
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
						archetype: "Unit",
						sectionId,
						values: {},
						components: { motion: { position: [0, 0, 0], velocity: [1, 2, 3], mass: 1 } },
						bakingEnabled: true,
					},
				},
			],
		},
	};
	return node;
}

function field(runtime: ECSRuntime, entityId: string, key: string): number[] {
	const chunk = runtime.world.chunks.find((entry) => entry.entityIds.includes(entityId))!;
	const row = chunk.entityIds.indexOf(entityId);
	const column = chunk.columns[key];
	return Array.from(column.values.slice(row * column.arity, (row + 1) * column.arity));
}

describe("ecs/runtime", () => {
	test("executes fixed, update, and late portable kernels with bounded traces", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = addEntity(scene, "unit");
		const runtime = new ECSRuntime(scene, configuration(), false);
		const first = runtime.step(0.025);
		expect(first).toMatchObject({ frame: 1, fixedSteps: 2, backend: "main-thread", scalarWrites: 11 });
		const position = field(runtime, "unit", "motion.position");
		expect(position[0]).toBeCloseTo(0.02);
		expect(position[1]).toBeCloseTo(0.04);
		expect(position[2]).toBeCloseTo(0.06);
		expect(node.position.asArray()[0]).toBeCloseTo(0.02);
		expect(node.position.asArray()[1]).toBeCloseTo(0.04);
		expect(node.position.asArray()[2]).toBeCloseTo(0.06);
		expect(field(runtime, "unit", "motion.mass")).toEqual([3]);
		runtime.step(0);
		expect(field(runtime, "unit", "motion.mass")).toEqual([4]);
		for (let index = 0; index < 10; index++) runtime.step(0);
		expect(runtime.traces).toHaveLength(16);
		expect(runtime.report.kernelBackend).toBe("portable-typed-array");
		expect(runtime.schedule.diagnostics[0]).toContain("not Unity Burst");
	});

	test("plays structural commands atomically after iteration and supports debugger queries", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		addEntity(scene, "unit");
		addEntity(scene, "combat", "combat");
		const runtime = new ECSRuntime(scene, configuration(), false);
		const generation = runtime.world.generation;
		runtime.queueCommand({ kind: "instantiate-entity", sourceEntityId: "unit", entityId: "clone" }, generation);
		runtime.queueCommand({ kind: "set-field", entityId: "clone", componentId: "motion", fieldId: "mass", value: 4 }, generation);
		runtime.queueCommand({ kind: "set-section-loaded", sectionId: "combat", loaded: true }, generation);
		expect(runtime.playbackCommands()).toBe(3);
		expect(runtime.world.entityCount).toBe(3);
		expect(runtime.world.activeEntityCount).toBe(3);
		expect(field(runtime, "clone", "motion.mass")).toEqual([4]);
		const cloneChunk = runtime.world.chunks.find((chunk) => chunk.entityIds.includes("clone"))!;
		const cloneRow = cloneChunk.entityIds.indexOf("clone");
		expect(cloneChunk.authoredEntities[cloneRow]).toBe(false);
		expect(cloneChunk.parentEntityIds[cloneRow]).toBeNull();
		const query: any = runtime.query({ all: ["motion"], loadedOnly: true, includeValues: true, offset: 0, limit: 2 });
		expect(query).toMatchObject({ total: 3, returned: 2, hasMore: true });

		const nextGeneration = runtime.world.generation;
		runtime.queueCommand({ kind: "destroy-entity", entityId: "clone" }, nextGeneration);
		runtime.step(0);
		expect(runtime.world.entityCount).toBe(2);
		expect(() => runtime.queueCommand({ kind: "destroy-entity", entityId: "unit" }, generation)).not.toThrow();
		expect(() => runtime.playbackCommands()).toThrow("generation changed");
	});

	test("supports lifecycle, exact rebakes, scene ownership, and worker fallback evidence", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		addEntity(scene, "unit");
		const value = configuration();
		value.settings.executionMode = "worker";
		const runtime = configureECSRuntime(scene, value);
		expect(getECSRuntime(scene)).toBe(runtime);
		expect(runtime.pause().status).toBe("paused");
		expect(runtime.start().status).toBe("running");
		expect(runtime.stop().status).toBe("stopped");
		const step = await runtime.stepAsync(0.01);
		if (!supportsECSWorkers()) {
			expect(step.backend).toBe("main-thread");
			expect(runtime.report.workerFallbackReason).toContain("unavailable");
		}
		const generation = runtime.world.generation;
		expect(() => runtime.rebake(value, { expectedGeneration: generation + 1 })).toThrow("generation changed");
		value.revision++;
		expect(runtime.rebake(value, { expectedGeneration: generation }).configurationRevision).toBe(1);
		expect(runtime.snapshot(true)).toMatchObject({ runtime: { entityCount: 1 }, world: { entityCount: 1 } });
		disposeECSRuntime(scene);
		expect(getECSRuntime(scene)).toBeNull();
		expect(runtime.status).toBe("disposed");
	});

	test("activates only authored scenes and completes main-thread transforms before later frame observers", () => {
		const empty = new Scene(new NullEngine());
		expect(configureAuthoredECSRuntime(empty)).toBeNull();
		expect(empty.metadata).toBeNull();
		empty.dispose();

		const scene = new Scene(new NullEngine());
		addEntity(scene, "unit");
		const value = configuration();
		value.settings.executionMode = "main-thread";
		value.systems.push({
			id: "moveConstant",
			name: "Move Constant",
			namespace: "Game.Simulation",
			enabled: true,
			phase: "update",
			order: 0,
			query: { all: ["motion"], any: [], none: [] },
			reads: [],
			writes: [{ componentId: "motion", fieldId: "position" }],
			dependsOn: [],
			operations: [{ id: "addPosition", kind: "add", target: { componentId: "motion", fieldId: "position" }, constant: 1, useDeltaTime: false }],
		});
		scene.metadata = { babylonEditorECS: value };
		const runtime = configureAuthoredECSRuntime(scene)!;
		let observedPosition = 0;
		scene.onBeforeRenderObservable.add(() => (observedPosition = (scene.getNodeById("unit") as TransformNode).position.x));
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(runtime.report.frame).toBe(1);
		expect(observedPosition).toBe(1);
		scene.dispose();
	});

	test("dispatches eligible batches through the Worker transport and applies returned columns", async () => {
		const originalWorker = (globalThis as any).Worker;
		class FakeWorker {
			public onmessage: ((event: any) => void) | null = null;
			public onerror: ((event: any) => void) | null = null;

			public postMessage(message: any): void {
				queueMicrotask(() => {
					try {
						let scalarWrites = 0;
						for (const operation of message.task.operations) {
							const target = message.task.columns[operation.targetKey];
							const source = operation.sourceKey ? message.task.columns[operation.sourceKey] : null;
							const factor = operation.useDeltaTime ? message.task.deltaSeconds : 1;
							const lanes = message.task.count * operation.targetArity;
							for (let index = 0; index < lanes; index++) {
								if (operation.kind === "add") target[index] += operation.constant * factor;
								else if (operation.kind === "integrate") target[index] += source[index] * operation.constant * factor;
								else if (operation.kind === "copy") target[index] = source[index] * factor;
								else if (operation.kind === "clamp") target[index] = Math.min(operation.maximum, Math.max(operation.minimum, target[index]));
							}
							scalarWrites += lanes;
						}
						this.onmessage?.({ data: { id: message.id, columns: message.task.columns, scalarWrites } });
					} catch (error) {
						this.onerror?.({ message: String(error) });
					}
				});
			}

			public terminate(): void {}
		}
		(globalThis as any).Worker = FakeWorker;
		try {
			const engine = new NullEngine();
			const scene = new Scene(engine);
			addEntity(scene, "unit");
			const value = configuration();
			value.settings.executionMode = "worker";
			value.settings.workerCount = 1;
			const runtime = new ECSRuntime(scene, value, false);
			const result = await runtime.stepAsync(0.01);
			expect(result.backend).toBe("worker");
			expect(runtime.report).toMatchObject({ workerSupported: true, workerCount: 1, workerFallbackReason: null });
			expect(field(runtime, "unit", "motion.mass")).toEqual([3]);
			expect(runtime.traces.some((trace) => trace.backend === "worker")).toBe(true);
			runtime.dispose();
		} finally {
			(globalThis as any).Worker = originalWorker;
		}
	});

	test("rejects command bounds and duplicate runtime entity ids without publishing partial state", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		addEntity(scene, "unit");
		const runtime = new ECSRuntime(scene, configuration(), false);
		const generation = runtime.world.generation;
		runtime.queueCommand({ kind: "set-field", entityId: "unit", componentId: "motion", fieldId: "mass", value: 11 }, generation);
		runtime.queueCommand({ kind: "instantiate-entity", sourceEntityId: "unit", entityId: "unit" }, generation);
		expect(() => runtime.playbackCommands()).toThrow("outside configured bounds");
		expect(runtime.world.generation).toBe(generation);
		expect(runtime.world.entityCount).toBe(1);
	});
});

import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import "@babylonjs/core/Materials/standardMaterial";

import { describe, expect, test } from "vitest";

import { Buffer } from "node:buffer";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { SceneSerializer } from "@babylonjs/core/Misc/sceneSerializer";

import {
	bakeEntityWorld,
	configureGameObjectComponents,
	getNetworkComponentData,
	normalizeEntityComponentData,
	getRuntimeGameObjectComponent,
	getRuntimeGameObjectComponents,
	getRuntimeGameObjectComponentsByType,
	normalizeNetworkComponentData,
} from "../../src/loading/game-object-components";
import { loadSceneAdditive } from "../../src/loading/additive-scene";

describe("loading/game-object-components", () => {
	test("materializes enabled custom data in authored order and ignores adapter rows", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = new TransformNode("Actor", scene);
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{ id: "disabled", type: "data", enabled: false, data: { name: "Disabled", values: { value: 0 } } },
					{ id: "script-adapter", type: "script", enabled: true, data: { attachmentId: "script" } },
					{ id: "stats", type: "data", enabled: true, data: { name: "Stats", values: { health: 100 } } },
					{ id: "inventory", type: "data", enabled: true, data: { name: "Inventory", values: { slots: 8 } } },
				],
			},
		};

		configureGameObjectComponents(scene);
		expect(getRuntimeGameObjectComponents(node)).toEqual([
			{ id: "stats", type: "data", enabled: true, order: 3, data: { name: "Stats", values: { health: 100 } } },
			{ id: "inventory", type: "data", enabled: true, order: 4, data: { name: "Inventory", values: { slots: 8 } } },
		]);
		expect(getRuntimeGameObjectComponent(node, "stats")?.data).toEqual({ name: "Stats", values: { health: 100 } });
		expect(getRuntimeGameObjectComponentsByType(node, "data")).toHaveLength(2);

		(node.metadata.babylonEditorComponentStack.components[2].data.values as any).health = 1;
		expect((getRuntimeGameObjectComponent(node, "stats")?.data.values as any).health).toBe(100);

		scene.dispose();
		engine.dispose();
	});

	test("fails open for malformed or future component data", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = new TransformNode("Future", scene);
		node.metadata = { babylonEditorComponentStack: { version: 99, components: [{ id: "future", type: "data", enabled: true, data: {} }] } };
		configureGameObjectComponents(scene);
		expect(getRuntimeGameObjectComponents(node)).toEqual([]);
		scene.dispose();
		engine.dispose();
	});

	test("survives Babylon serialization, additive load, runtime access, and unload teardown", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		const mesh = new Mesh("Serialized Actor", source);
		mesh.id = "serialized-actor";
		mesh.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "health", type: "data", enabled: true, data: { name: "Health", values: { current: 75 } } }],
			},
		};
		const serialized = SceneSerializer.Serialize(source);
		expect(serialized.meshes[0].metadata.babylonEditorComponentStack.components[0].id).toBe("health");
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const targetEngine = new NullEngine();
		const target = new Scene(targetEngine);
		const handle = await loadSceneAdditive("", dataUrl, target, {});
		const loaded = handle.getNodeById("serialized-actor")!;
		expect(getRuntimeGameObjectComponent(loaded, "health")?.data).toEqual({ name: "Health", values: { current: 75 } });
		await handle.unload();
		expect(getRuntimeGameObjectComponents(loaded)).toEqual([]);
		target.dispose();
		targetEngine.dispose();
	});

	test("materializes an authored network replication contract alongside data components", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = new TransformNode("Player", scene);
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [
					{ id: "stats", type: "data", enabled: true, data: { name: "Stats", values: { health: 100 } } },
					{
						id: "net",
						type: "network",
						enabled: true,
						data: { networkId: "player-1", authority: "owner", syncTransform: true, syncAnimation: true, sendRateHz: 30, interpolate: false },
					},
				],
			},
		};

		configureGameObjectComponents(scene);

		expect(getRuntimeGameObjectComponentsByType(node, "network")).toHaveLength(1);
		expect(getNetworkComponentData(node)).toEqual({
			networkId: "player-1",
			authority: "owner",
			syncTransform: true,
			syncAnimation: true,
			sendRateHz: 30,
			interpolate: false,
		});
		// The data component is unaffected by the new type.
		expect(getRuntimeGameObjectComponent(node, "stats")?.data).toEqual({ name: "Stats", values: { health: 100 } });

		scene.dispose();
		engine.dispose();
	});

	test("a disabled network component leaves the node unreplicated", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const node = new TransformNode("Prop", scene);
		node.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "net", type: "network", enabled: false, data: { networkId: "prop-1" } }],
			},
		};

		configureGameObjectComponents(scene);

		expect(getNetworkComponentData(node)).toBeNull();
		expect(getRuntimeGameObjectComponentsByType(node, "network")).toHaveLength(0);

		scene.dispose();
		engine.dispose();
	});

	test("normalizes malformed replication settings instead of throwing", () => {
		// Authored data can be hand-edited or produced by an older editor, so
		// every field must fall back to a safe default rather than break loading.
		expect(normalizeNetworkComponentData({})).toEqual({
			networkId: "",
			authority: "server",
			syncTransform: true,
			syncAnimation: false,
			sendRateHz: 20,
			interpolate: true,
		});

		// Out-of-range and wrong-typed values are clamped/coerced, not trusted.
		expect(normalizeNetworkComponentData({ authority: "nonsense", sendRateHz: 100000 }).authority).toBe("server");
		expect(normalizeNetworkComponentData({ sendRateHz: 100000 }).sendRateHz).toBe(120);
		expect(normalizeNetworkComponentData({ sendRateHz: 0 }).sendRateHz).toBe(1);
		expect(normalizeNetworkComponentData({ sendRateHz: -5 }).sendRateHz).toBe(1);
		expect(normalizeNetworkComponentData({ sendRateHz: Number.NaN }).sendRateHz).toBe(20);
		expect(normalizeNetworkComponentData({ sendRateHz: 29.6 }).sendRateHz).toBe(30);
		expect(normalizeNetworkComponentData({ networkId: 42 as unknown as string }).networkId).toBe("");
	});

	test("bakes entities into deterministic struct-of-arrays archetype chunks", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);

		const makeEntity = (name: string, id: string, data: Record<string, unknown>, enabled = true) => {
			const node = new TransformNode(name, scene);
			node.id = id;
			node.metadata = { babylonEditorComponentStack: { version: 1, components: [{ id: "e", type: "entity", enabled, data }] } };
			return node;
		};

		// Two archetypes, authored out of alphabetical order, with a field that
		// only one member of "Unit" declares.
		makeEntity("B", "unit-b", { archetype: "Unit", values: { hp: 50, armor: 5 } });
		makeEntity("A", "unit-a", { archetype: "Unit", values: { hp: 100 } });
		makeEntity("P", "pickup-1", { archetype: "Pickup", values: { value: 7 } });
		makeEntity("Off", "unit-off", { archetype: "Unit", values: { hp: 1 } }, false); // disabled component
		makeEntity("NoBake", "unit-nobake", { archetype: "Unit", values: { hp: 2 }, bakingEnabled: false });

		const world = bakeEntityWorld(scene);

		// Archetypes are sorted, so the bake is reproducible run to run.
		expect(world.archetypes.map((a) => a.archetype)).toEqual(["Pickup", "Unit"]);
		expect(world.entityCount).toBe(3);

		const unit = world.archetypes.find((a) => a.archetype === "Unit")!;
		expect(unit.entityIds).toEqual(["unit-b", "unit-a"]);
		// Columns are dense and aligned: "armor" is 0 for the entity that omitted it.
		expect(unit.fields).toEqual({ armor: [5, 0], hp: [50, 100] });
		expect(unit.count).toBe(2);
		unit.entityIds.forEach((_, index) => {
			Object.values(unit.fields).forEach((column) => expect(column).toHaveLength(unit.entityIds.length));
			expect(typeof unit.fields.hp[index]).toBe("number");
		});

		// Disabled components and bakingEnabled:false are both excluded.
		expect(unit.entityIds).not.toContain("unit-off");
		expect(unit.entityIds).not.toContain("unit-nobake");

		scene.dispose();
		engine.dispose();
	});

	test("normalizes malformed entity data and drops non-numeric fields", () => {
		expect(normalizeEntityComponentData({})).toEqual({
			version: 3,
			archetype: "Default",
			sectionId: "main",
			values: {},
			components: {},
			bakingEnabled: true,
			hiddenInHierarchy: false,
		});
		// Only finite numeric fields survive — a data-oriented column cannot hold a string.
		expect(normalizeEntityComponentData({ archetype: "  ", values: { good: 3, bad: "x", nan: Number.NaN } })).toEqual({
			version: 3,
			archetype: "Default",
			sectionId: "main",
			values: { good: 3 },
			components: {},
			bakingEnabled: true,
			hiddenInHierarchy: false,
		});
		expect(normalizeEntityComponentData({ archetype: "  Squad  " }).archetype).toBe("Squad");
	});

	test("an empty scene bakes to an empty world rather than throwing", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		expect(bakeEntityWorld(scene)).toEqual({ version: 1, archetypes: [], entityCount: 0 });
		scene.dispose();
		engine.dispose();
	});

	test("the replication contract survives serialization and additive load", async () => {
		const sourceEngine = new NullEngine();
		const source = new Scene(sourceEngine);
		const mesh = new Mesh("Networked Actor", source);
		mesh.id = "networked-actor";
		mesh.metadata = {
			babylonEditorComponentStack: {
				version: 1,
				components: [{ id: "net", type: "network", enabled: true, data: { networkId: "actor-7", authority: "server", sendRateHz: 15 } }],
			},
		};
		const serialized = SceneSerializer.Serialize(source);
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
		source.dispose();
		sourceEngine.dispose();

		const targetEngine = new NullEngine();
		const target = new Scene(targetEngine);
		const handle = await loadSceneAdditive("", dataUrl, target, {});
		const loaded = handle.getNodeById("networked-actor")!;

		expect(getNetworkComponentData(loaded)).toEqual({
			networkId: "actor-7",
			authority: "server",
			syncTransform: true,
			syncAnimation: false,
			sendRateHz: 15,
			interpolate: true,
		});

		await handle.unload();
		expect(getNetworkComponentData(loaded)).toBeNull();
		target.dispose();
		targetEngine.dispose();
	});
});

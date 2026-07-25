import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { mkdtemp, remove } from "fs-extra";
import { tmpdir } from "os";
import { join } from "path/posix";

import { Mesh, NullEngine, Scene, TransformNode } from "babylonjs";
import { bakeEntityWorld, getRuntimeGameObjectComponents } from "babylonjs-editor-tools";

import { projectConfiguration } from "../../src/project/configuration";
import {
	addGameObjectComponent,
	copyGameObjectComponent,
	inspectGameObjectComponents,
	listGameObjectComponentTypes,
	moveGameObjectComponent,
	pasteGameObjectComponent,
	removeGameObjectComponent,
	resetGameObjectComponent,
	setGameObjectComponent,
} from "../../src/mcp/components/components";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

describe("mcp/game-object-components", () => {
	let directory: string;
	let previousPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } },
		},
	} as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-components-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
		clearUndoRedo();
	});

	afterEach(async () => {
		clearUndoRedo();
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await remove(directory);
	});

	test("authors stable ordered data components with exact leases, reset, and undo/redo", () => {
		const node = new TransformNode("Actor", scene);
		const initial = inspectGameObjectComponents(scene, { nodeId: node.id });
		expect(initial.components.map((component: any) => component.type)).toEqual(["transform"]);
		expect(initial.components[0]).toMatchObject({ id: "transform", order: 0, removable: false, canToggle: false });

		const first = addGameObjectComponent(
			scene,
			{ nodeId: node.id, expectedFingerprint: initial.fingerprint, type: "data", name: "Health", values: { current: 100, maximum: 100 } },
			options
		);
		expect(first.components[1]).toMatchObject({ type: "data", label: "Health", order: 1, enabled: true });
		expect(getRuntimeGameObjectComponents(node as any).map((component) => component.id)).toEqual([first.components[1].id]);
		expect(() => addGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: initial.fingerprint, type: "data", name: "Stale" }, options)).toThrow(
			"changed after inspection"
		);

		const second = addGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: first.fingerprint, type: "data", name: "Inventory", values: { slots: 8 } }, options);
		const inventoryId = second.components[2].id;
		const moved = moveGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: second.fingerprint, componentId: inventoryId, targetOrder: 1 }, options);
		expect(moved.components.map((component: any) => component.label)).toEqual(["Transform", "Inventory", "Health"]);

		const changed = setGameObjectComponent(
			scene,
			{ nodeId: node.id, expectedFingerprint: moved.fingerprint, componentId: inventoryId, enabled: false, name: "Backpack", values: { slots: 16 } },
			options
		);
		expect(changed.components[1]).toMatchObject({ label: "Backpack", enabled: false, data: { name: "Backpack", values: { slots: 16 } } });

		const reset = resetGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: changed.fingerprint, componentId: inventoryId }, options);
		expect(reset.components[1]).toMatchObject({ label: "Data Component", enabled: true, data: { name: "Data Component", values: {} } });
		undo();
		expect(inspectGameObjectComponents(scene, { nodeId: node.id }).components[1]).toMatchObject({ label: "Backpack", enabled: false });
		redo();
		expect(inspectGameObjectComponents(scene, { nodeId: node.id }).components[1]).toMatchObject({ label: "Data Component", enabled: true });
	});

	test("migrates existing script attachments without changing their runtime storage", () => {
		const node = new TransformNode("Scripted", scene);
		node.metadata = { scripts: [{ key: "movement.ts", enabled: true, executionOrder: 25, values: { speed: { value: 4 } } }] };
		const first = inspectGameObjectComponents(scene, { nodeId: node.id });
		const script = first.components.find((component: any) => component.type === "script");
		expect(script).toMatchObject({ label: "movement.ts", enabled: true, data: { path: "src/movement.ts", executionOrder: 25 } });
		expect(node.metadata.scripts[0]._id).toBeUndefined();

		const second = inspectGameObjectComponents(scene, { nodeId: node.id });
		expect(second.components.find((component: any) => component.type === "script").id).toBe(script.id);
		const changed = setGameObjectComponent(
			scene,
			{ nodeId: node.id, expectedFingerprint: second.fingerprint, componentId: script.id, enabled: false, script: { executionOrder: -100, values: { speed: { value: 7 } } } },
			options
		);
		expect(node.metadata.scripts[0]).toMatchObject({ key: "movement.ts", enabled: false, executionOrder: -100, values: { speed: { value: 7 } } });
		expect(node.metadata.scripts[0]._id).toBeTypeOf("string");
		expect(changed.components.find((component: any) => component.id === script.id).enabled).toBe(false);
	});

	test("copies and pastes guarded component values or a new component across nodes", () => {
		const source = new TransformNode("Source", scene);
		const target = new TransformNode("Target", scene);
		const sourceInitial = inspectGameObjectComponents(scene, { nodeId: source.id });
		const sourceWithData = addGameObjectComponent(
			scene,
			{ nodeId: source.id, expectedFingerprint: sourceInitial.fingerprint, type: "data", name: "Stats", values: { score: 42 } },
			options
		);
		const componentId = sourceWithData.components[1].id;
		const copied = copyGameObjectComponent(scene, { nodeId: source.id, expectedFingerprint: sourceWithData.fingerprint, componentId });

		const targetInitial = inspectGameObjectComponents(scene, { nodeId: target.id });
		const pasted = pasteGameObjectComponent(
			scene,
			{
				nodeId: target.id,
				expectedFingerprint: targetInitial.fingerprint,
				expectedClipboardFingerprint: copied.clipboardFingerprint,
				mode: "new",
			},
			options
		);
		expect(pasted.components[1]).toMatchObject({ type: "data", label: "Stats", data: { name: "Stats", values: { score: 42 } } });
		expect(pasted.components[1].id).not.toBe(componentId);
		expect(() =>
			pasteGameObjectComponent(scene, { nodeId: target.id, expectedFingerprint: pasted.fingerprint, expectedClipboardFingerprint: "0".repeat(64), mode: "new" }, options)
		).toThrow("clipboard changed");
	});

	test("removes adapter state atomically and rejects required Transform removal", () => {
		const node = new TransformNode("Actor", scene);
		const initial = inspectGameObjectComponents(scene, { nodeId: node.id });
		expect(() => removeGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: initial.fingerprint, componentId: "transform" }, options)).toThrow(
			"required and cannot be removed"
		);
		const added = addGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: initial.fingerprint, type: "data", name: "Temporary" }, options);
		const removed = removeGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: added.fingerprint, componentId: added.components[1].id }, options);
		expect(removed.components).toHaveLength(1);
		expect(getRuntimeGameObjectComponents(node as any)).toEqual([]);
		undo();
		expect(inspectGameObjectComponents(scene, { nodeId: node.id }).components).toHaveLength(2);
		expect(getRuntimeGameObjectComponents(node as any)).toHaveLength(1);
	});

	test("publishes explicit duplicate, dependency, and node support rules", () => {
		const node = new TransformNode("Actor", scene);
		const registry = listGameObjectComponentTypes(scene, { nodeId: node.id });
		expect(registry.types.find((type: any) => type.type === "transform")).toMatchObject({ allowMultiple: false, removable: false, canAdd: false });
		expect(registry.types.find((type: any) => type.type === "data")).toMatchObject({ allowMultiple: true, requiredTypes: ["transform"], canAdd: true });
		expect(registry.types.find((type: any) => type.type === "physics3d")).toMatchObject({ allowMultiple: false, canAdd: false });
		expect(registry.types.find((type: any) => type.type === "network")).toMatchObject({
			label: "Network Replication",
			allowMultiple: false,
			removable: true,
			canToggle: true,
			requiredTypes: ["transform"],
			canAdd: true,
		});
	});

	test("authors an entity archetype that bakes into struct-of-arrays chunks", () => {
		const node = new TransformNode("Unit", scene);
		node.id = "unit-1";
		const initial = inspectGameObjectComponents(scene, { nodeId: node.id });

		const added = addGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: initial.fingerprint, type: "entity" }, options);
		const component = added.components.find((entry: any) => entry.type === "entity");
		expect(component).toMatchObject({ label: "Entity (ECS)", removable: true, canToggle: true });
		expect(component.data).toMatchObject({ archetype: "Default", bakingEnabled: true });

		const configured = setGameObjectComponent(
			scene,
			{ nodeId: node.id, expectedFingerprint: added.fingerprint, componentId: component.id, data: { archetype: "Unit", values: { hp: 42 } } },
			options
		);
		expect(configured.components.find((entry: any) => entry.type === "entity").data).toMatchObject({ archetype: "Unit", values: { hp: 42 } });

		const world = bakeEntityWorld(scene as any);
		expect(world.entityCount).toBe(1);
		expect(world.archetypes[0]).toMatchObject({ archetype: "Unit", entityIds: ["unit-1"], fields: { hp: [42] }, count: 1 });
	});

	test("authors a single network replication contract that reaches the runtime", () => {
		const node = new TransformNode("Networked Actor", scene);
		const initial = inspectGameObjectComponents(scene, { nodeId: node.id });

		const added = addGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: initial.fingerprint, type: "network" }, options);
		const component = added.components.find((entry: any) => entry.type === "network");
		expect(component).toMatchObject({ label: "Network Replication", removable: true, canToggle: true });

		// Only one replication contract may own a node.
		expect(listGameObjectComponentTypes(scene, { nodeId: node.id }).types.find((type: any) => type.type === "network").canAdd).toBe(false);

		const configured = setGameObjectComponent(
			scene,
			{
				nodeId: node.id,
				expectedFingerprint: added.fingerprint,
				componentId: component.id,
				data: { networkId: "actor-1", authority: "owner", syncTransform: true, syncAnimation: true, sendRateHz: 30, interpolate: false },
			},
			options
		);
		expect(configured.components.find((entry: any) => entry.type === "network").data).toMatchObject({ networkId: "actor-1", authority: "owner", sendRateHz: 30 });

		// The authored contract is materialized for the runtime netcode layer.
		const runtime = getRuntimeGameObjectComponents(node as any).find((entry: any) => entry.type === "network");
		expect(runtime).toMatchObject({ type: "network", enabled: true });
		expect(runtime!.data).toMatchObject({ networkId: "actor-1", authority: "owner", sendRateHz: 30, interpolate: false });

		// Removal is undoable like every other component row.
		const removed = removeGameObjectComponent(scene, { nodeId: node.id, expectedFingerprint: configured.fingerprint, componentId: component.id }, options);
		expect(removed.components.map((entry: any) => entry.type)).toEqual(["transform"]);
		undo();
		expect(inspectGameObjectComponents(scene, { nodeId: node.id }).components.some((entry: any) => entry.type === "network")).toBe(true);
	});

	test("adapts a real mesh PhysicsAggregate without duplicating its authoritative state", () => {
		const mesh = new Mesh("Physics Actor", scene);
		const dispose = vi.fn();
		const aggregate = {
			shape: {
				type: 3,
				density: 1,
				filterMembershipMask: 2,
				filterCollideMask: 4,
				material: { friction: 0.4, restitution: 0.1, staticFriction: 0.5, frictionCombine: 0, restitutionCombine: 0 },
			},
			body: {
				getMotionType: () => 1,
				getMassProperties: () => ({ mass: 5 }),
			},
			dispose,
		};
		(mesh as any).physicsAggregate = aggregate;
		(mesh as any).physicsBody = aggregate.body;

		const inspection = inspectGameObjectComponents(scene, { nodeId: mesh.id });
		const physics = inspection.components.find((component: any) => component.type === "physics3d");
		expect(physics).toMatchObject({ label: "Physics Body 3D", removable: true, canToggle: false });
		expect(physics.data).toMatchObject({ massProperties: { mass: 5 }, filterMembershipMask: 2, filterCollideMask: 4 });
		expect(listGameObjectComponentTypes(scene, { nodeId: mesh.id }).types.find((type: any) => type.type === "physics3d").canAdd).toBe(false);

		const removed = removeGameObjectComponent(scene, { nodeId: mesh.id, expectedFingerprint: inspection.fingerprint, componentId: physics.id }, options);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(removed.components.map((component: any) => component.type)).toEqual(["transform"]);
	});
});

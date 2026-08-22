import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine, Scene } from "babylonjs";

vi.mock("babylonjs-editor-tools", async (importOriginal) => ({ ...(await importOriginal<typeof import("babylonjs-editor-tools")>()) }));

import { validatePhysicsScene } from "../../src/mcp/physics/constraints";
import { findPhysicsCollisionLayer, getPhysicsCollisionLayers, setPhysicsCollisionLayers } from "../../src/mcp/scene/scene";

describe("mcp/physics-diagnostics", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("reports a warning but no error for a scene without active physics", () => {
		const result = validatePhysicsScene(scene);
		expect(result.valid).toBe(true);
		expect(result.statistics).toMatchObject({ physicsEngineActive: false, bodyCount: 0, constraintCount: 0 });
		expect(result.warnings.join(" ")).toContain("no enabled physics bodies");
	});

	test("reports persisted constraints that reference missing nodes", () => {
		scene.metadata = { babylonEditorPhysicsConstraints: [{ id: "broken-joint", type: "hinge", parentNodeId: "missing-a", childNodeId: "missing-b" }] };
		const result = validatePhysicsScene(scene);
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toContain("broken-joint");
		expect(result.errors.join(" ")).toContain("missing node");
	});

	test("persists validated named collision layers and rejects duplicate or invalid bits", () => {
		const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;
		const result = setPhysicsCollisionLayers(
			scene,
			{
				layers: [
					{ name: "Player", bit: 1, collidesWith: 3 },
					{ name: "World", bit: 2, collidesWith: 1 },
				],
			},
			options
		);
		expect(result.layers).toEqual([
			{ name: "Player", bit: 1, collidesWith: 3 },
			{ name: "World", bit: 2, collidesWith: 1 },
		]);
		expect(getPhysicsCollisionLayers(scene)).toEqual(result);
		expect(findPhysicsCollisionLayer(scene, "Player")).toEqual({ name: "Player", bit: 1, collidesWith: 3 });
		expect(findPhysicsCollisionLayer(scene, "Missing")).toBeUndefined();
		expect(() => setPhysicsCollisionLayers(scene, { layers: [{ name: "A", bit: 3, collidesWith: 1 }] }, options)).toThrow("single membership bit");
		expect(() =>
			setPhysicsCollisionLayers(
				scene,
				{
					layers: [
						{ name: "A", bit: 1, collidesWith: 1 },
						{ name: "A", bit: 2, collidesWith: 1 },
					],
				},
				options
			)
		).toThrow("names must be non-empty and unique");
	});

	test("resolves the implicit Default collision layer for a new scene", () => {
		expect(findPhysicsCollisionLayer(scene, "Default")).toEqual({ name: "Default", bit: 1, collidesWith: 0xffff });
	});

	test("normalizes legacy 32-bit collision masks so read output can be written back", () => {
		const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;
		scene.metadata = { babylonEditorPhysicsCollisionLayers: { layers: [{ name: "Legacy", bit: 1, collidesWith: 0xffffffff }] } };
		const read = getPhysicsCollisionLayers(scene);
		expect(read).toEqual({ layers: [{ name: "Legacy", bit: 1, collidesWith: 0xffff }] });
		expect(() => setPhysicsCollisionLayers(scene, read, options)).not.toThrow();
	});
});

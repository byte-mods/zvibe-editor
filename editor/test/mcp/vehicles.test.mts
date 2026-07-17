import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, PhysicsMotionType, Scene } from "babylonjs";

import { createVehicle, listVehicles, setVehicleInput, setVehicleWheels, validateVehicles } from "../../src/mcp/physics/vehicles";

describe("mcp/vehicles", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("persists a dynamic chassis controller and keeps injected preview input transient", () => {
		const chassis = MeshBuilder.CreateBox("Chassis", { size: 100 }, scene);
		(chassis as any).physicsAggregate = { body: { getMotionType: () => PhysicsMotionType.DYNAMIC } };

		expect(createVehicle(scene, { id: "car", name: "Player Car", chassisNodeId: chassis.id }, options)).toMatchObject({
			id: "car",
			chassisNodeId: chassis.id,
			maxEngineForce: 25000,
			wheels: [{ id: "front-left" }, { id: "front-right" }, { id: "rear-left" }, { id: "rear-right" }],
		});
		expect(setVehicleInput(scene, { id: "car", throttle: 1, steering: -0.5, brake: 0.25 })).toMatchObject({ input: { throttle: 1, steering: -0.5, brake: 0.25 } });
		expect(listVehicles(scene).vehicles).toMatchObject([{ id: "car", input: { throttle: 1, steering: -0.5, brake: 0.25 } }]);
		expect(scene.metadata.babylonEditorVehicles[0]).not.toHaveProperty("input");
		expect(() => setVehicleWheels(scene, { id: "car", wheels: [{ id: "same" }, { id: "same" }] }, options)).toThrow("connectionPoint");
	});

	test("rejects a non-dynamic chassis and reports missing input mapping as a warning", () => {
		const chassis = MeshBuilder.CreateBox("Static Chassis", { size: 100 }, scene);
		(chassis as any).physicsAggregate = { body: { getMotionType: () => PhysicsMotionType.STATIC } };
		expect(() => createVehicle(scene, { chassisNodeId: chassis.id }, options)).toThrow("dynamic physics body");
		(scene.metadata ??= {}).babylonEditorVehicles = [
			{
				id: "broken",
				name: "Broken",
				chassisNodeId: chassis.id,
				enabled: true,
				maxEngineForce: 1,
				maxBrakeForce: 1,
				maxSpeed: 1,
				maxSteerAngle: 0,
				wheelBase: 1,
				lateralGrip: 0,
			},
		];
		expect(validateVehicles(scene)).toMatchObject({ errors: [expect.stringContaining("dynamic chassis")], warnings: [expect.stringContaining("no input action map")] });
	});
});

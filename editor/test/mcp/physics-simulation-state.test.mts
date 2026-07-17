import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, PhysicsMotionType, PhysicsShapeType, Scene, Vector3 } from "babylonjs";

import { getPhysicsSimulationState } from "../../src/mcp/physics/constraints";

describe("mcp/physics simulation state", () => {
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

	test("reads available body pose and velocity without advancing the simulation", () => {
		const mesh = MeshBuilder.CreateBox("Crate", { size: 1 }, scene);
		mesh.position.set(10, 20, 30);
		(mesh as any).physicsAggregate = {
			body: {
				getMotionType: () => PhysicsMotionType.DYNAMIC,
				getMassProperties: () => ({ mass: 5 }),
				getLinearVelocity: () => new Vector3(1, 2, 3),
				getAngularVelocity: () => new Vector3(4, 5, 6),
			},
			shape: { type: PhysicsShapeType.BOX },
		};
		vi.spyOn(scene, "getPhysicsEngine").mockReturnValue({} as any);

		const snapshot = getPhysicsSimulationState(scene);
		expect(snapshot).toMatchObject({
			physicsEngineActive: true,
			bodies: [{ nodeId: mesh.id, name: "Crate", mass: 5, position: [10, 20, 30], linearVelocity: [1, 2, 3], angularVelocity: [4, 5, 6] }],
		});
		expect(snapshot.validation.statistics).toMatchObject({ bodyCount: 1, physicsEngineActive: true });
	});
});

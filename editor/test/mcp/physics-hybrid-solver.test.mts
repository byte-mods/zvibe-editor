import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { MeshBuilder, NullEngine, PhysicsMotionType, PhysicsShapeType, Scene, Vector3 } from "babylonjs";

import {
	createHybridPhysicsGearCoupling,
	deleteHybridPhysicsGearCoupling,
	getHybridPhysicsCapabilities,
	getHybridPhysicsSolver,
	resetHybridPhysicsSolver,
	setHybridPhysicsSolver,
	setPhysicsConstraintSolver,
} from "../../src/mcp/physics/hybrid-solver";

describe("mcp/hybrid physics solver", () => {
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				layout: {
					inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() },
					preview: { setRenderScene: vi.fn() },
					graph: { refresh: vi.fn(async () => undefined) },
				},
			},
		};
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	function physicsMesh(name: string): any {
		const mesh = MeshBuilder.CreateBox(name, { size: 1 }, scene);
		(mesh as any).physicsAggregate = {
			body: {
				getMotionType: () => PhysicsMotionType.DYNAMIC,
				getMassProperties: () => ({ mass: 1 }),
				getLinearVelocity: () => Vector3.Zero(),
				getAngularVelocity: () => Vector3.Zero(),
				setLinearVelocity: vi.fn(),
				setAngularVelocity: vi.fn(),
			},
			shape: { type: PhysicsShapeType.BOX },
		};
		return mesh;
	}

	test("shares exact solver settings and gear lifecycle with the Inspector owner", () => {
		const first = physicsMesh("first");
		const second = physicsMesh("second");
		expect(getHybridPhysicsCapabilities()).toMatchObject({ maximumDirectRows: 256, sharedEditorAndExportRuntime: true });

		const configured = setHybridPhysicsSolver(scene, { expectedRevision: 1, maximumRows: 64, positionErrorBias: 0.3 }, options);
		expect(configured.configuration).toMatchObject({ revision: 2, maximumRows: 64, positionErrorBias: 0.3 });
		expect(() => setHybridPhysicsSolver(scene, { expectedRevision: 1, enabled: false }, options)).toThrow("expectedRevision 2");

		const created = createHybridPhysicsGearCoupling(
			scene,
			{ expectedRevision: 2, id: "gears", name: "Gears", bodyANodeId: first.id, bodyBNodeId: second.id, axisA: [0, 0, 1], axisB: [0, 0, 1], ratio: 2 },
			options
		);
		expect(created).toMatchObject({ coupling: { id: "gears", ratio: 2 }, configurationRevision: 3 });
		expect(getHybridPhysicsSolver(scene).configuration.gearCouplings).toHaveLength(1);
		expect(() => deleteHybridPhysicsGearCoupling(scene, { expectedRevision: 3, id: "gears", confirm: false }, options)).toThrow("confirm: true");
		expect(deleteHybridPhysicsGearCoupling(scene, { expectedRevision: 3, id: "gears", confirm: true }, options)).toMatchObject({ deleted: true, configurationRevision: 4 });
		expect(resetHybridPhysicsSolver(scene, { expectedRevision: 4, confirm: true }, options)).toMatchObject({ reset: true, persisted: false });
		expect(getHybridPhysicsSolver(scene)).toMatchObject({ persisted: false, configuration: { revision: 1, gearCouplings: [] } });
	});

	test("marks supported native constraints as direct under an exact per-constraint revision", () => {
		scene.metadata = { babylonEditorPhysicsConstraints: [{ id: "joint", type: "hinge", parentNodeId: "a", childNodeId: "b" }] };
		expect(setPhysicsConstraintSolver(scene, { id: "joint", expectedRevision: 1, solverMode: "direct" }, options)).toMatchObject({
			id: "joint",
			revision: 2,
			solverMode: "direct",
		});
		expect(() => setPhysicsConstraintSolver(scene, { id: "joint", expectedRevision: 1, solverMode: "iterative" }, options)).toThrow("expectedRevision 2");

		scene.metadata.babylonEditorPhysicsConstraints.push({ id: "slider", type: "slider", parentNodeId: "a", childNodeId: "b" });
		expect(() => setPhysicsConstraintSolver(scene, { id: "slider", expectedRevision: 1, solverMode: "direct" }, options)).toThrow("remains iterative");
	});
});

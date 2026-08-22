import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

import { DynamicNavMeshObstacleManager, INavigationObstaclePlugin } from "../../src/loading/nav-obstacles";

describe("loading/nav obstacles", () => {
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

	test("uses current world bounds and full height for a live cylinder mesh", () => {
		const cylinder = MeshBuilder.CreateCylinder("Cylinder", { diameter: 80, height: 100 }, scene);
		cylinder.scaling.set(1.5, 2, 1.5);
		let receivedRadius = 0;
		let receivedHeight = 0;
		const addCylinderObstacle = vi.fn((_position: Vector3, radius: number, height: number) => {
			receivedRadius = radius;
			receivedHeight = height;
			return { type: "cylinder" as const, ref: {} };
		});
		const plugin: INavigationObstaclePlugin = {
			navMesh: {},
			tileCache: { update: () => ({ success: true, status: 0, upToDate: true }) },
			addCylinderObstacle,
			addBoxObstacle: vi.fn(() => ({ type: "box" as const, ref: {} })),
			removeObstacle: vi.fn(),
		};

		const manager = new DynamicNavMeshObstacleManager(plugin, scene, [
			{
				id: cylinder.id,
				enabled: true,
				type: "cylinder",
				radius: 1,
				height: 1,
				carving: true,
				dynamic: true,
				carveOnlyStationary: false,
			},
		]);

		expect(addCylinderObstacle).toHaveBeenCalledOnce();
		expect(receivedRadius).toBeCloseTo(60, 3);
		expect(receivedHeight).toBeCloseTo(200, 3);
		manager.dispose();
	});
});

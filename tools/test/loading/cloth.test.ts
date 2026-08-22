import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";

import { configureCloths, getClothSimulationControl, setClothSimulationPaused, stepPausedClothSimulation } from "../../src/loading/cloth";

describe("loading/cloth", () => {
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

	test("restores local box collision for exported cloth vertices", () => {
		const mesh = new Mesh("Cloth", scene);
		mesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array(27), true);
		mesh.setIndices([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 5, 7, 5, 8, 7]);
		mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(27), true);
		scene.metadata = {
			babylonEditorCloths: [
				{ id: "cloth", meshId: mesh.id, subdivisions: 2, pinnedVertices: [0], gravity: [0, 0, 0], collisionBoxes: [{ center: [0, 0, 0], size: [20, 20, 20] }] },
			],
		};

		configureCloths(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const position = mesh.getVerticesData(VertexBuffer.PositionKind)!;
		expect(Math.max(Math.abs(position[3]), Math.abs(position[4]), Math.abs(position[5]))).toBeGreaterThanOrEqual(10);
	});

	test("uses a persisted scene mesh as a transformed exported-runtime bounds collider", () => {
		const mesh = new Mesh("Cloth", scene);
		mesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array(27), true);
		mesh.setIndices([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 5, 7, 5, 8, 7]);
		mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(27), true);
		const collider = MeshBuilder.CreateBox("Collider", { size: 20 }, scene);
		scene.metadata = { babylonEditorCloths: [{ id: "cloth", meshId: mesh.id, subdivisions: 2, pinnedVertices: [0], gravity: [0, 0, 0], collisionMeshIds: [collider.id] }] };
		configureCloths(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const position = mesh.getVerticesData(VertexBuffer.PositionKind)!;
		expect(Math.max(Math.abs(position[12]), Math.abs(position[13]), Math.abs(position[14]))).toBeGreaterThanOrEqual(10);
	});

	test("separates non-neighbouring coincident cloth vertices when self-collision is enabled", () => {
		const mesh = new Mesh("Cloth", scene);
		mesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array(27), true);
		mesh.setIndices([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 5, 7, 5, 8, 7]);
		mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(27), true);
		scene.metadata = {
			babylonEditorCloths: [{ id: "cloth", meshId: mesh.id, subdivisions: 2, pinnedVertices: [0], gravity: [0, 0, 0], selfCollision: true, selfCollisionRadius: 20 }],
		};
		configureCloths(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		const position = mesh.getVerticesData(VertexBuffer.PositionKind)!;
		expect(Math.hypot(position[24], position[25], position[26])).toBeGreaterThanOrEqual(17.999);
	});

	test("pauses automatic cloth delivery and advances one exact manual frame", () => {
		const mesh = new Mesh("Manual Cloth", scene);
		mesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array(27), true);
		mesh.setIndices([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4, 3, 4, 6, 4, 7, 6, 4, 5, 7, 5, 8, 7]);
		mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(27), true);
		scene.metadata = { babylonEditorCloths: [{ id: "manual-cloth", meshId: mesh.id, subdivisions: 2, pinnedVertices: [0], gravity: [0, -100, 0] }] };
		configureCloths(scene);
		configureCloths(scene);
		vi.spyOn(engine, "getDeltaTime").mockReturnValue(16);

		expect(setClothSimulationPaused(scene, true)).toMatchObject({ paused: true, registeredCloths: 1, enabledCloths: 1 });
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(mesh.getVerticesData(VertexBuffer.PositionKind)![4]).toBe(0);

		const stepped = stepPausedClothSimulation(scene, 0.02);
		expect(stepped).toMatchObject({ paused: true, steppedCloths: 1, totalManualSteps: 1, totalManualSeconds: 0.02, lastStepSeconds: 0.02 });
		expect(mesh.getVerticesData(VertexBuffer.PositionKind)![4]).toBeLessThan(0);
		expect(getClothSimulationControl(scene).totalAutomaticSteps).toBe(0);

		setClothSimulationPaused(scene, false);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(getClothSimulationControl(scene)).toMatchObject({ paused: false, totalAutomaticSteps: 1 });
	});

	test("reports a manual cloth failure and leaves the controller paused", () => {
		const mesh = new Mesh("Broken Cloth", scene);
		mesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array(27), true);
		mesh.setIndices([0, 1, 3]);
		mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(27), true);
		scene.metadata = { babylonEditorCloths: [{ id: "broken-cloth", meshId: mesh.id, subdivisions: 2, pinnedVertices: [0], gravity: [0, -100, 0] }] };
		configureCloths(scene);
		setClothSimulationPaused(scene, true);
		mesh.removeVerticesData(VertexBuffer.PositionKind);

		expect(() => stepPausedClothSimulation(scene, 0.02)).toThrow('Cloth "broken-cloth" has no position vertex buffer');
		expect(getClothSimulationControl(scene)).toMatchObject({ paused: true, executingManualStep: false, totalManualSteps: 0, lastError: { completedCloths: 0 } });
	});

	test("enforces persistent maximum-distance and surface-penetration vertex constraints", () => {
		const mesh = new Mesh("Constrained Cloth", scene);
		const positions = new Float32Array([-10, 10, 0, 0, 10, 0, 10, 10, 0, -10, 0, 0, 0, 0, 0, 10, 0, 0, -10, -10, 0, 0, -10, 0, 10, -10, 0]);
		mesh.setVerticesData(VertexBuffer.PositionKind, positions, true);
		mesh.setIndices([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8]);
		mesh.setVerticesData(VertexBuffer.NormalKind, new Float32Array(Array.from({ length: 9 }, () => [0, 0, 1]).flat()), true);
		scene.metadata = {
			babylonEditorCloths: [
				{
					id: "constrained-cloth",
					meshId: mesh.id,
					subdivisions: 2,
					pinnedVertices: [0],
					gravity: [0, -1000, -1000],
					vertexConstraints: [
						{ vertexIndex: 4, maxDistance: 3, surfacePenetration: 2 },
						{ vertexIndex: 8, maxDistance: 0 },
					],
				},
			],
		};
		configureCloths(scene);
		setClothSimulationPaused(scene, true);
		for (let index = 0; index < 4; index++) {
			stepPausedClothSimulation(scene, 0.05);
		}
		const result = mesh.getVerticesData(VertexBuffer.PositionKind)!;
		expect(Math.hypot(result[12], result[13], result[14])).toBeLessThanOrEqual(3.0001);
		expect(result[14]).toBeGreaterThanOrEqual(-2.0001);
		expect(Array.from(result.slice(24, 27))).toEqual([10, -10, 0]);
		expect(getClothSimulationControl(scene).clothDiagnostics[0]).toMatchObject({
			vertexConstraints: 2,
			maximumDistanceConstraints: 2,
			surfacePenetrationConstraints: 1,
		});
	});

	test("collides against the current transformed triangles and reports bounded work", () => {
		const cloth = new Mesh("Triangle Cloth", scene);
		cloth.setVerticesData(
			VertexBuffer.PositionKind,
			new Float32Array([-10, 10, 5, 0, 10, 5, 10, 10, 5, -10, 0, 5, 0, 0, 5, 10, 0, 5, -10, -10, 5, 0, -10, 5, 10, -10, 5]),
			true
		);
		cloth.setVerticesData(VertexBuffer.NormalKind, new Float32Array(Array.from({ length: 9 }, () => [0, 0, 1]).flat()), true);
		cloth.setIndices([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8]);
		const collider = new Mesh("Moving Triangle Collider", scene);
		collider.setVerticesData(VertexBuffer.PositionKind, [-100, -100, 0, 100, -100, 0, 100, 100, 0, -100, 100, 0]);
		collider.setIndices([0, 1, 2, 0, 2, 3]);
		scene.metadata = {
			babylonEditorCloths: [
				{
					id: "triangle-cloth",
					meshId: cloth.id,
					subdivisions: 2,
					pinnedVertices: [0],
					gravity: [0, 0, -1000],
					triangleColliders: [{ meshId: collider.id, thickness: 1, restitution: 0, friction: 0.2 }],
				},
			],
		};
		configureCloths(scene);
		collider.position.z = 2;
		setClothSimulationPaused(scene, true);
		stepPausedClothSimulation(scene, 0.1);
		const result = cloth.getVerticesData(VertexBuffer.PositionKind)!;
		expect(result[14]).toBeGreaterThanOrEqual(2.999);
		expect(getClothSimulationControl(scene).clothDiagnostics[0]).toMatchObject({
			configuredColliders: 1,
			activeColliders: 1,
			triangles: 2,
			workTruncated: false,
		});
		expect(getClothSimulationControl(scene).clothDiagnostics[0].contacts).toBeGreaterThan(0);
		expect(getClothSimulationControl(scene).clothDiagnostics[0].candidateTests).toBeGreaterThan(0);
	});

	test("skips malformed legacy triangle collider settings without producing invalid simulation values", () => {
		const cloth = new Mesh("Malformed Collider Cloth", scene);
		cloth.setVerticesData(
			VertexBuffer.PositionKind,
			new Float32Array([-10, 10, 5, 0, 10, 5, 10, 10, 5, -10, 0, 5, 0, 0, 5, 10, 0, 5, -10, -10, 5, 0, -10, 5, 10, -10, 5]),
			true
		);
		cloth.setVerticesData(VertexBuffer.NormalKind, new Float32Array(Array.from({ length: 9 }, () => [0, 0, 1]).flat()), true);
		cloth.setIndices([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8]);
		const collider = MeshBuilder.CreatePlane("Malformed Collider", { size: 100 }, scene);
		scene.metadata = {
			babylonEditorCloths: [
				{
					id: "malformed-collider-cloth",
					meshId: cloth.id,
					subdivisions: 2,
					pinnedVertices: [0],
					gravity: [0, 0, -100],
					triangleColliders: [{ meshId: collider.id, thickness: -1, restitution: Number.NaN, friction: 2 }],
				},
			],
		};
		configureCloths(scene);
		setClothSimulationPaused(scene, true);
		stepPausedClothSimulation(scene, 0.02);
		const diagnostics = getClothSimulationControl(scene).clothDiagnostics[0];
		expect(diagnostics).toMatchObject({ configuredColliders: 1, activeColliders: 0, skippedColliders: 1, contacts: 0 });
		expect(Array.from(cloth.getVerticesData(VertexBuffer.PositionKind)!).every(Number.isFinite)).toBe(true);
	});

	test("skips malformed legacy triangle geometry before building collision acceleration data", () => {
		const cloth = new Mesh("Malformed Geometry Cloth", scene);
		cloth.setVerticesData(
			VertexBuffer.PositionKind,
			new Float32Array([-10, 10, 5, 0, 10, 5, 10, 10, 5, -10, 0, 5, 0, 0, 5, 10, 0, 5, -10, -10, 5, 0, -10, 5, 10, -10, 5]),
			true
		);
		cloth.setVerticesData(VertexBuffer.NormalKind, new Float32Array(Array.from({ length: 9 }, () => [0, 0, 1]).flat()), true);
		cloth.setIndices([0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5, 3, 6, 4, 4, 6, 7, 4, 7, 5, 5, 7, 8]);
		const collider = new Mesh("Malformed Geometry Collider", scene);
		collider.setVerticesData(VertexBuffer.PositionKind, [Number.NaN, 0, 0, 10, 0, 0, 0, 10, 0]);
		collider.setIndices([0, 1, 2]);
		scene.metadata = {
			babylonEditorCloths: [
				{
					id: "malformed-geometry-cloth",
					meshId: cloth.id,
					subdivisions: 2,
					pinnedVertices: [0],
					gravity: [0, 0, -100],
					triangleColliders: [{ meshId: collider.id, thickness: 1, restitution: 0, friction: 0.2 }],
				},
			],
		};
		configureCloths(scene);
		setClothSimulationPaused(scene, true);
		stepPausedClothSimulation(scene, 0.02);
		expect(getClothSimulationControl(scene).clothDiagnostics[0]).toMatchObject({ configuredColliders: 1, activeColliders: 0, skippedColliders: 1, contacts: 0 });
		expect(Array.from(cloth.getVerticesData(VertexBuffer.PositionKind)!).every(Number.isFinite)).toBe(true);
	});
});

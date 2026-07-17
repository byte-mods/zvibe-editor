import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Scene } from "@babylonjs/core/scene";

import { configureCloths } from "../../src/loading/cloth";

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
});

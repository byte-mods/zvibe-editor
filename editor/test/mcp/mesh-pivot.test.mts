import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Matrix, Mesh, MeshBuilder, NullEngine, Quaternion, Scene, TransformNode, Vector3, VertexData } from "babylonjs";

import { captureMeshPivotSnapshot, getMeshPivot, restoreMeshPivotSnapshot, setMeshPivot } from "../../src/mcp/meshes/pivot";

function worldVertices(mesh: Mesh): number[][] {
	const matrix = mesh.computeWorldMatrix(true);
	const positions = mesh.getVerticesData("position", false)!;
	const result: number[][] = [];
	for (let index = 0; index < positions.length; index += 3) {
		result.push(Vector3.TransformCoordinates(Vector3.FromArray(positions, index), matrix).asArray());
	}
	return result;
}

function expectPointsClose(actual: number[][], expected: number[][], precision = 5): void {
	expect(actual).toHaveLength(expected.length);
	for (let index = 0; index < actual.length; index++) {
		expect(actual[index][0]).toBeCloseTo(expected[index][0], precision);
		expect(actual[index][1]).toBeCloseTo(expected[index][1], precision);
		expect(actual[index][2]).toBeCloseTo(expected[index][2], precision);
	}
}

function expectValuesClose(actual: number[], expected: number[], precision = 5): void {
	expect(actual).toHaveLength(expected.length);
	for (let index = 0; index < actual.length; index++) {
		expect(actual[index]).toBeCloseTo(expected[index], precision);
	}
}

describe("mcp/mesh-pivot", () => {
	let engine: NullEngine;
	let scene: Scene;
	let mesh: Mesh;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		mesh = MeshBuilder.CreateBox("Pivot Mesh", { size: 10 }, scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("sets a world pivot through a rotated, negatively scaled hierarchy without moving geometry or descendants", () => {
		const parent = new TransformNode("Parent", scene);
		parent.position.set(80, -20, 30);
		parent.rotationQuaternion = Quaternion.RotationYawPitchRoll(0.4, -0.3, 0.2);
		parent.scaling.set(-1.5, 0.8, 2.2);
		mesh.parent = parent;
		mesh.position.set(20, 30, -40);
		mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(-0.2, 0.5, 0.1);
		mesh.scaling.set(1.2, 2.3, 0.7);
		const child = new TransformNode("Child", scene);
		child.parent = mesh;
		child.position.set(2, 5, -3);

		const beforeVertices = worldVertices(mesh);
		const beforeWorld = Array.from(mesh.getWorldMatrix().asArray());
		const beforeChildWorld = Array.from(child.computeWorldMatrix(true).asArray());
		const inspected = getMeshPivot(scene, { nodeId: mesh.id });
		const target = [110, 40, -20];
		const result = setMeshPivot(scene, { nodeId: mesh.id, expectedPivotFingerprint: inspected.pivotFingerprint, mode: "world", worldPosition: target }, options);

		expect(result).toMatchObject({
			model: "unity-world-stable-mesh-pivot-v1",
			source: { mode: "world" },
			verification: { worldGeometryPreserved: true, topologyPreserved: true, preservedDescendantCount: 1 },
		});
		expect(result.pivot.world[0]).toBeCloseTo(target[0], 4);
		expect(result.pivot.world[1]).toBeCloseTo(target[1], 4);
		expect(result.pivot.world[2]).toBeCloseTo(target[2], 4);
		expectPointsClose(worldVertices(mesh), beforeVertices);
		expectValuesClose(Array.from(mesh.getWorldMatrix().asArray()), beforeWorld);
		expectValuesClose(Array.from(child.computeWorldMatrix(true).asArray()), beforeChildWorld);
		expect(result.pivotFingerprint).not.toBe(inspected.pivotFingerprint);
		expect(result.topologyFingerprint).toBe(inspected.topologyFingerprint);
	});

	test("centers the pivot on raw object bounds while preserving a non-centered mesh", () => {
		const vertexData = new VertexData();
		vertexData.positions = [2, 4, 6, 12, 4, 6, 2, 24, 6];
		vertexData.indices = [0, 1, 2];
		vertexData.applyToMesh(mesh, true);
		mesh.position.set(7, 8, 9);
		const before = worldVertices(mesh);
		const inspected = getMeshPivot(scene, { nodeId: mesh.id });
		expect(inspected.geometry.boundsCenterLocal).toEqual([7, 14, 6]);
		const result = setMeshPivot(scene, { nodeId: mesh.id, expectedPivotFingerprint: inspected.pivotFingerprint, mode: "boundsCenter" }, options);
		expect(result.pivot.local).toEqual([7, 14, 6]);
		expect(result.source).toEqual({ mode: "boundsCenter" });
		expectPointsClose(worldVertices(mesh), before);
	});

	test.each([
		{ selectionMode: "vertex", componentIndices: [0, 2], expected: [2, 2, 0], selectedVertexCount: 2 },
		{ selectionMode: "edge", componentIndices: [0], expected: [2, 0, 0], selectedVertexCount: 2 },
		{ selectionMode: "face", componentIndices: [1], expected: [4 / 3, 8 / 3, 0], selectedVertexCount: 3 },
	] as const)("sets the pivot to the unique $selectionMode component-vertex average", ({ selectionMode, componentIndices, expected, selectedVertexCount }) => {
		const vertexData = new VertexData();
		vertexData.positions = [0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0];
		vertexData.indices = [0, 1, 2, 0, 2, 3];
		vertexData.applyToMesh(mesh, true);
		const before = worldVertices(mesh);
		const inspected = getMeshPivot(scene, { nodeId: mesh.id });
		const result = setMeshPivot(
			scene,
			{ nodeId: mesh.id, expectedPivotFingerprint: inspected.pivotFingerprint, mode: "selectionAverage", selectionMode, componentIndices: [...componentIndices] },
			options
		);
		expect(result.selectedVertexCount).toBe(selectedVertexCount);
		expect(result.pivot.local[0]).toBeCloseTo(expected[0]);
		expect(result.pivot.local[1]).toBeCloseTo(expected[1]);
		expect(result.pivot.local[2]).toBeCloseTo(expected[2]);
		expectPointsClose(worldVertices(mesh), before);
	});

	test("reports the current persisted component candidate and round-trips exact snapshots", () => {
		mesh.metadata = { babylonEditorMeshSelection: { mode: "face", indices: [0] } };
		const before = captureMeshPivotSnapshot(scene, { nodeId: mesh.id });
		const inspected = getMeshPivot(scene, { nodeId: mesh.id });
		expect(inspected.selection).toMatchObject({ mode: "face", componentIndices: [0], vertexCount: 3 });
		setMeshPivot(scene, { nodeId: mesh.id, expectedPivotFingerprint: inspected.pivotFingerprint, mode: "boundsCenter" }, options);
		const after = captureMeshPivotSnapshot(scene, { nodeId: mesh.id });
		expect(after).not.toEqual(before);
		restoreMeshPivotSnapshot(scene, { nodeId: mesh.id }, before, options);
		expect(captureMeshPivotSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		restoreMeshPivotSnapshot(scene, { nodeId: mesh.id }, after, options);
		expect(captureMeshPivotSnapshot(scene, { nodeId: mesh.id })).toEqual(after);
		expect(Array.from((mesh as any).serialize().pivotMatrix)).toEqual(after.pivotMatrix);
	});

	test("rejects stale leases, invalid mode fields, duplicate selections, and out-of-range components without mutation", () => {
		const before = captureMeshPivotSnapshot(scene, { nodeId: mesh.id });
		const inspected = getMeshPivot(scene, { nodeId: mesh.id });
		expect(() => setMeshPivot(scene, { nodeId: mesh.id, expectedPivotFingerprint: "stale", mode: "boundsCenter" }, options)).toThrow("stale");
		expect(() =>
			setMeshPivot(scene, { nodeId: mesh.id, expectedPivotFingerprint: inspected.pivotFingerprint, mode: "boundsCenter", worldPosition: [0, 0, 0] }, options)
		).toThrow("does not accept");
		expect(() =>
			setMeshPivot(
				scene,
				{ nodeId: mesh.id, expectedPivotFingerprint: inspected.pivotFingerprint, mode: "selectionAverage", selectionMode: "vertex", componentIndices: [0, 0] },
				options
			)
		).toThrow("unique");
		expect(() =>
			setMeshPivot(
				scene,
				{ nodeId: mesh.id, expectedPivotFingerprint: inspected.pivotFingerprint, mode: "selectionAverage", selectionMode: "face", componentIndices: [999] },
				options
			)
		).toThrow("integers");
		expect(captureMeshPivotSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
	});

	test("rejects frozen, billboard, singular, and arbitrary pre-transform states", () => {
		mesh.freezeWorldMatrix();
		expect(() => getMeshPivot(scene, { nodeId: mesh.id })).toThrow("frozen");
		mesh.unfreezeWorldMatrix();
		mesh.billboardMode = TransformNode.BILLBOARDMODE_ALL;
		expect(() => getMeshPivot(scene, { nodeId: mesh.id })).toThrow("camera-dependent");
		mesh.billboardMode = 0;
		mesh.scaling.x = 0;
		expect(() => getMeshPivot(scene, { nodeId: mesh.id })).toThrow("singular");
		mesh.scaling.x = 1;
		const parent = new TransformNode("Singular Parent", scene);
		parent.scaling.y = 0;
		mesh.parent = parent;
		expect(() => getMeshPivot(scene, { nodeId: mesh.id })).toThrow("singular inherited");
		mesh.parent = null;
		mesh.setPivotMatrix(Matrix.RotationY(0.2), false);
		expect(() => getMeshPivot(scene, { nodeId: mesh.id })).toThrow("non-translation pre-transform");
	});
});

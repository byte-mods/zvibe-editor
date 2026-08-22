import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveGeometrySource } from "../src/pack/scene.mjs";

describe("editable generated geometry packing", () => {
	let sceneDirectory: string;

	beforeEach(async () => {
		sceneDirectory = await mkdtemp(join(tmpdir(), "zvibe-generated-geometry-"));
		await mkdir(join(sceneDirectory, "geometries"));
		await mkdir(join(sceneDirectory, "generatedGeometries"));
		await writeFile(join(sceneDirectory, "geometries", "source.babylonbinarymeshdata"), Buffer.from([1, 2, 3]));
		await writeFile(join(sceneDirectory, "generatedGeometries", "mesh.babylonbinarymeshdata"), Buffer.from([7, 8]));
	});

	afterEach(async () => {
		await rm(sceneDirectory, { recursive: true, force: true });
	});

	function createMesh(): any {
		return {
			delayLoadingFile: "assets/Scene/geometries/source.babylonbinarymeshdata",
			_binaryInfo: { positionsAttrDesc: { count: 99 } },
			metadata: {
				keepAtRuntime: true,
				babylonEditorMeshSelection: { mode: "face", indices: [0] },
				babylonEditorUvLayout: { version: 1 },
				babylonEditorSmoothingGroups: { version: 1 },
				babylonEditorVertexColors: { version: 1 },
				babylonEditorEditableMeshSource: {
					version: 1,
					model: "unity-editable-source-generated-export-v1",
					revision: 4,
					sourceFingerprint: "source-fingerprint",
					exportSettingsRevision: 2,
					exportSettings: { optimize: true },
					lastGenerated: {
						file: "generatedGeometries/mesh.babylonbinarymeshdata",
						binaryInfo: { positionsAttrDesc: { count: 9, stride: 3, offset: 0, dataType: 1 } },
						sourceFingerprint: "source-fingerprint",
						generatedFingerprint: "generated-fingerprint",
						exportSettingsRevision: 2,
						settings: { optimize: true },
						source: { vertexCount: 5, faceCount: 2 },
						generated: { vertexCount: 3, faceCount: 2 },
						removedUnusedOrDuplicateVertices: 2,
						compilationModel: "exact-complete-record-weld-v1",
					},
				},
			},
		};
	}

	test("selects the separately generated artifact, binary layout, and lean runtime metadata", async () => {
		const mesh = createMesh();
		const result = await resolveGeometrySource(sceneDirectory, mesh);

		expect(result).toMatchObject({
			sourceFile: "generatedGeometries/mesh.babylonbinarymeshdata",
			outputFile: "mesh.babylonbinarymeshdata",
		});
		expect([...result.buffer]).toEqual([7, 8]);
		expect(mesh._binaryInfo.positionsAttrDesc.count).toBe(9);
		expect(mesh.metadata.keepAtRuntime).toBe(true);
		expect(mesh.metadata.babylonEditorEditableMeshSource).toBeUndefined();
		expect(mesh.metadata.babylonEditorMeshSelection).toBeUndefined();
		expect(mesh.metadata.babylonEditorGeneratedGeometry).toMatchObject({
			model: "unity-editable-source-generated-export-v1",
			sourceRevision: 4,
			generatedFingerprint: "generated-fingerprint",
			generated: { vertexCount: 3 },
		});
	});

	test("falls back to canonical source when generated evidence is stale", async () => {
		const mesh = createMesh();
		mesh.metadata.babylonEditorEditableMeshSource.lastGenerated.sourceFingerprint = "stale";
		const result = await resolveGeometrySource(sceneDirectory, mesh);

		expect(result).toMatchObject({ sourceFile: "geometries/source.babylonbinarymeshdata", outputFile: "source.babylonbinarymeshdata" });
		expect([...result.buffer]).toEqual([1, 2, 3]);
		expect(mesh._binaryInfo.positionsAttrDesc.count).toBe(99);
		expect(mesh.metadata.babylonEditorEditableMeshSource).toBeDefined();
	});

	test("rejects manifest path traversal by using the canonical source", async () => {
		const mesh = createMesh();
		mesh.metadata.babylonEditorEditableMeshSource.lastGenerated.file = "generatedGeometries/../geometries/source.babylonbinarymeshdata";
		const result = await resolveGeometrySource(sceneDirectory, mesh);

		expect(result.sourceFile).toBe("geometries/source.babylonbinarymeshdata");
		expect([...result.buffer]).toEqual([1, 2, 3]);
	});
});

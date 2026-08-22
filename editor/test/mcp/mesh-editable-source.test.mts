import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Mesh, MorphTarget, MorphTargetManager, NullEngine, Scene, SubMesh, VertexBuffer } from "babylonjs";

import {
	EDITABLE_MESH_SOURCE_METADATA_KEY,
	applyGeneratedEditableMeshToSerializedData,
	buildGeneratedEditableMeshGeometry,
	captureEditableMeshSnapshot,
	captureMeshEditableSourceSnapshot,
	getEditableMeshSnapshotFingerprint,
	getMeshEditableSource,
	recordGeneratedEditableMeshArtifact,
	restoreMeshEditableSourceSnapshot,
	setMeshExportGeometry,
	stripEditableSourceMetadataForRuntime,
	synchronizeEditableMeshSourceManifest,
} from "../../src/mcp/meshes/editable-source";

function createEditableMesh(scene: Scene): Mesh {
	const mesh = new Mesh("Editable Source", scene);
	mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 9, 9, 9], true, 3);
	mesh.setVerticesData(VertexBuffer.NormalKind, [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], true, 3);
	mesh.setVerticesData(VertexBuffer.UVKind, [0, 0, 1, 0, 0, 1, 0, 0, 0.5, 0.5], true, 2);
	mesh.setIndices([0, 1, 2, 3, 2, 1], null, true);
	mesh.releaseSubMeshes(true);
	new SubMesh(2, 0, 3, 0, 3, mesh, mesh, false, true);
	new SubMesh(5, 1, 3, 3, 3, mesh, mesh, false, true);
	return mesh;
}

describe("mcp/mesh-editable-source", () => {
	let engine: NullEngine;
	let scene: Scene;
	let mesh: Mesh;
	const options = { editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		mesh = createEditableMesh(scene);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("builds a detached optimized artifact while preserving every canonical source value", () => {
		const before = captureEditableMeshSnapshot(mesh);
		const sourceFingerprint = getEditableMeshSnapshotFingerprint(before);
		const generated = buildGeneratedEditableMeshGeometry(mesh, { optimize: true });

		expect(generated.evidence).toMatchObject({
			model: "unity-editable-source-generated-export-v1",
			compilationModel: "exact-complete-record-weld-v1",
			sourceFingerprint,
			source: { vertexCount: 5, faceCount: 2, subMeshCount: 2 },
			generated: { vertexCount: 3, faceCount: 2, subMeshCount: 2 },
			removedUnusedOrDuplicateVertices: 2,
			portableBinaryOutput: true,
			sourcePreserved: true,
		});
		expect(generated.snapshot.indices).toEqual([0, 1, 2, 0, 2, 1]);
		expect(generated.snapshot.subMeshes.map((subMesh) => subMesh.materialIndex)).toEqual([2, 5]);
		expect(captureEditableMeshSnapshot(mesh)).toEqual(before);
		expect(getEditableMeshSnapshotFingerprint(captureEditableMeshSnapshot(mesh))).toBe(sourceFingerprint);
	});

	test("preserve mode retains exact source record layout and does not initialize metadata during inspection", () => {
		const state = getMeshEditableSource(scene, { nodeId: mesh.id });
		expect(state).toMatchObject({
			ownership: {
				canonical: "live-and-project-source-geometry",
				generated: "detached-derived-runtime-artifact",
				projectSourceDirectory: "geometries",
				projectGeneratedDirectory: "generatedGeometries",
			},
			source: { revision: 1, vertexCount: 5 },
			exportSettings: { revision: 1, optimize: true },
			generated: { vertexCount: 3, sourcePreserved: true },
		});
		expect(mesh.metadata?.[EDITABLE_MESH_SOURCE_METADATA_KEY]).toBeUndefined();

		const preserved = buildGeneratedEditableMeshGeometry(mesh, { optimize: false });
		expect(preserved.snapshot).toEqual(captureEditableMeshSnapshot(mesh));
		expect(preserved.evidence.generatedFingerprint).toBe(preserved.evidence.sourceFingerprint);
	});

	test("ignores all GPU instance attributes when capturing editable vertex streams", () => {
		const geometryKinds = mesh.getVerticesDataKinds();
		const getVertexBuffer = mesh.getVertexBuffer.bind(mesh);
		vi.spyOn(mesh, "getVerticesDataKinds").mockReturnValue([...geometryKinds, "world0", "world1", "world2", "world3", "instanceSelectionId"]);
		vi.spyOn(mesh, "getVertexBuffer").mockImplementation((kind) => (kind === "instanceSelectionId" ? ({ getIsInstanced: () => true } as VertexBuffer) : getVertexBuffer(kind)));
		expect(mesh.getVerticesDataKinds()).toEqual(expect.arrayContaining(["world0", "world1", "world2", "world3", "instanceSelectionId"]));

		const snapshot = captureEditableMeshSnapshot(mesh);
		expect(snapshot.streams.map((stream) => stream.kind)).not.toEqual(expect.arrayContaining(["world0", "world1", "world2", "world3", "instanceSelectionId"]));
		expect(snapshot.streams.map((stream) => stream.kind)).toEqual([VertexBuffer.NormalKind, VertexBuffer.PositionKind, VertexBuffer.UVKind]);
	});

	test("updates export policy under exact independent source and settings leases", () => {
		const beforeGeometry = captureEditableMeshSnapshot(mesh);
		const inspected = getMeshEditableSource(scene, { nodeId: mesh.id });
		const result = setMeshExportGeometry(
			scene,
			{
				nodeId: mesh.id,
				expectedSourceFingerprint: inspected.source.fingerprint,
				expectedSourceRevision: inspected.source.revision,
				expectedExportSettingsRevision: inspected.exportSettings.revision,
				optimize: false,
			},
			options
		);
		expect(result).toMatchObject({ changed: true, exportSettings: { revision: 2, optimize: false }, generated: { vertexCount: 5 } });
		expect(captureEditableMeshSnapshot(mesh)).toEqual(beforeGeometry);

		const repeated = setMeshExportGeometry(
			scene,
			{
				nodeId: mesh.id,
				expectedSourceFingerprint: result.source.fingerprint,
				expectedSourceRevision: result.source.revision,
				expectedExportSettingsRevision: result.exportSettings.revision,
				optimize: false,
			},
			options
		);
		expect(repeated).toMatchObject({ changed: false, exportSettings: { revision: 2, optimize: false } });
	});

	test("rejects stale source and settings leases without changing source or policy", () => {
		const inspected = getMeshEditableSource(scene, { nodeId: mesh.id });
		const before = captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id });
		expect(() =>
			setMeshExportGeometry(
				scene,
				{
					nodeId: mesh.id,
					expectedSourceFingerprint: "stale",
					expectedSourceRevision: inspected.source.revision,
					expectedExportSettingsRevision: inspected.exportSettings.revision,
					optimize: false,
				},
				options
			)
		).toThrow("Editable source is stale");
		expect(() =>
			setMeshExportGeometry(
				scene,
				{
					nodeId: mesh.id,
					expectedSourceFingerprint: inspected.source.fingerprint,
					expectedSourceRevision: inspected.source.revision,
					expectedExportSettingsRevision: 999,
					optimize: false,
				},
				options
			)
		).toThrow("Export settings are stale");
		expect(captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
	});

	test("increments source revision after topology changes and invalidates persisted generated evidence", () => {
		const manifest = synchronizeEditableMeshSourceManifest(mesh);
		const generated = buildGeneratedEditableMeshGeometry(mesh);
		recordGeneratedEditableMeshArtifact(mesh, { file: "generatedGeometries/mesh.bin", binaryInfo: { positionsAttrDesc: { count: 9 } }, evidence: generated.evidence });
		expect(getMeshEditableSource(scene, { nodeId: mesh.id }).lastPersistedGeneratedArtifact).not.toBeNull();

		const positions = [...mesh.getVerticesData(VertexBuffer.PositionKind, false)!];
		positions[0] = 0.25;
		mesh.updateVerticesData(VertexBuffer.PositionKind, positions);
		const changed = getMeshEditableSource(scene, { nodeId: mesh.id });
		expect(changed.source.revision).toBe(manifest.revision + 1);
		expect(changed.lastPersistedGeneratedArtifact).toBeNull();
	});

	test("round-trips exact Inspector settings snapshots without touching geometry", () => {
		const geometry = captureEditableMeshSnapshot(mesh);
		const before = captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id });
		const inspected = getMeshEditableSource(scene, { nodeId: mesh.id });
		setMeshExportGeometry(
			scene,
			{
				nodeId: mesh.id,
				expectedSourceFingerprint: inspected.source.fingerprint,
				expectedSourceRevision: inspected.source.revision,
				expectedExportSettingsRevision: inspected.exportSettings.revision,
				optimize: false,
			},
			options
		);
		const after = captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id });
		restoreMeshEditableSourceSnapshot(scene, { nodeId: mesh.id }, before, options);
		expect(captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id })).toEqual(before);
		restoreMeshEditableSourceSnapshot(scene, { nodeId: mesh.id }, after, options);
		expect(captureMeshEditableSourceSnapshot(scene, { nodeId: mesh.id })).toEqual(after);
		expect(captureEditableMeshSnapshot(mesh)).toEqual(geometry);
	});

	test("applies generated data only to serializer objects and strips editor authoring metadata", () => {
		mesh.metadata = {
			keepAtRuntime: true,
			babylonEditorMeshSelection: { mode: "face", indices: [0] },
			babylonEditorUvLayout: { version: 1 },
			babylonEditorSmoothingGroups: { version: 1 },
			babylonEditorVertexColors: { version: 1 },
		};
		const sourceBefore = captureEditableMeshSnapshot(mesh);
		const manifest = synchronizeEditableMeshSourceManifest(mesh);
		const generated = buildGeneratedEditableMeshGeometry(mesh);
		const serializedMesh: any = { metadata: JSON.parse(JSON.stringify(mesh.metadata)), subMeshes: [] };
		const serializedGeometry: any = { positions: [999], indices: [999] };
		applyGeneratedEditableMeshToSerializedData(serializedMesh, serializedGeometry, generated);
		stripEditableSourceMetadataForRuntime(serializedMesh, generated.evidence, manifest.revision, manifest.exportSettingsRevision);

		expect(serializedGeometry.positions).toEqual(generated.geometry.positions);
		expect(serializedMesh.subMeshes).toEqual(generated.snapshot.subMeshes);
		expect(serializedMesh.metadata.keepAtRuntime).toBe(true);
		expect(serializedMesh.metadata.babylonEditorMeshSelection).toBeUndefined();
		expect(serializedMesh.metadata[EDITABLE_MESH_SOURCE_METADATA_KEY]).toBeUndefined();
		expect(serializedMesh.metadata.babylonEditorGeneratedGeometry).toMatchObject({
			model: "unity-editable-source-generated-export-v1",
			sourceFingerprint: generated.evidence.sourceFingerprint,
			generatedFingerprint: generated.evidence.generatedFingerprint,
		});
		expect(captureEditableMeshSnapshot(mesh)).toEqual(sourceBefore);
	});

	test("reports unsupported custom binary streams without discarding them from source identity", () => {
		mesh.setVerticesData("customEditorStream", [1, 2, 3, 4, 5], true, 1);
		const generated = buildGeneratedEditableMeshGeometry(mesh);
		expect(generated.evidence).toMatchObject({ portableBinaryOutput: false, unsupportedSerializedStreams: ["customEditorStream"] });
		expect(generated.snapshot.streams.find((stream) => stream.kind === "customEditorStream")?.values).toEqual([1, 2, 3, 4]);
	});

	test("preserves source vertex identity when morph targets block safe welding", () => {
		const manager = new MorphTargetManager(scene);
		manager.addTarget(new MorphTarget("Smile"));
		mesh.morphTargetManager = manager;
		const generated = buildGeneratedEditableMeshGeometry(mesh, { optimize: true });

		expect(generated.evidence).toMatchObject({
			compilationModel: "preserve-source-records-morph-target-safe-v1",
			optimizationApplied: false,
			optimizationBlockers: ["1 morph targets require source vertex identity"],
			source: { vertexCount: 5 },
			generated: { vertexCount: 5 },
			removedUnusedOrDuplicateVertices: 0,
		});
	});
});

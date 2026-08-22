import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import type { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";
import { Scene } from "@babylonjs/core/scene";
import { configureDeferredLighting, stopDeferredLighting } from "babylonjs-editor-tools";

import { createDecal, getDecal, listDecals, setDecal } from "../../src/mcp/meshes/meshes";

function installGeometryBuffer(scene: Scene): GeometryBufferRenderer {
	const target = { textures: [{}, {}, {}], count: 3, getSize: () => ({ width: 320, height: 180 }), isReady: () => true };
	const renderer = {
		isSupported: true,
		renderTransparentMeshes: false,
		normalsAreUnsigned: true,
		enableDepth: true,
		enableNormal: true,
		enablePosition: false,
		enableVelocity: false,
		enableVelocityLinear: false,
		enableReflectivity: false,
		enableScreenspaceDepth: false,
		enableIrradiance: false,
		getGBuffer: () => target,
		getTextureIndex: (type: number) => (type === 2 ? 0 : type === 1 ? 1 : type === 4 ? 2 : -1),
	} as unknown as GeometryBufferRenderer;
	scene.enableGeometryBufferRenderer = () => {
		(scene as unknown as { _geometryBufferRenderer: GeometryBufferRenderer | null })._geometryBufferRenderer = renderer;
		return renderer;
	};
	scene.disableGeometryBufferRenderer = () => {
		(scene as unknown as { _geometryBufferRenderer: GeometryBufferRenderer | null })._geometryBufferRenderer = null;
	};
	return renderer;
}

describe("mcp/decals", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = {
		editor: {
			layout: {
				graph: { refresh: vi.fn(async () => undefined), setSelectedNode: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		engine.getCaps().drawBuffersExtension = true;
		engine.getCaps().maxDrawBuffers = 8;
		scene = new Scene(engine);
		camera = new FreeCamera("Deferred Decal Camera", new Vector3(0, 0, -500), scene);
		camera.setTarget(Vector3.Zero());
		scene.activeCamera = camera;
		installGeometryBuffer(scene);
	});

	afterEach(() => {
		stopDeferredLighting(scene);
		scene.dispose();
		engine.dispose();
		vi.clearAllMocks();
	});

	test("creates, lists, reads, exact-revisions, updates, and reports deferred invalidation", () => {
		const source = CreateBox("Decal Receiver", { size: 100 }, scene);
		const receiverMaterial = new StandardMaterial("Receiver Material", scene);
		source.material = receiverMaterial;
		const material = new StandardMaterial("Alpha Decal Material", scene);
		material.diffuseColor.set(1, 0.2, 0.1);
		material.alpha = 0.5;
		material.zOffset = -2;
		const initialDeferred = configureDeferredLighting(scene, camera);
		expect(initialDeferred.errors).toEqual([]);
		expect(initialDeferred).toMatchObject({ active: true, decalActive: false });

		const created = createDecal(
			scene,
			{
				sourceNodeId: source.id,
				materialId: material.id,
				name: "Impact Decal",
				position: [0, 0, -50],
				normal: [0, 0, -1],
				size: [40, 50, 10],
				angle: 0.25,
				alphaIndex: 8,
				renderingGroupId: 0,
			},
			options
		);
		expect(created).toMatchObject({
			version: 1,
			revision: 1,
			angle: 0.25,
			sizeX: 40,
			sizeY: 50,
			sizeZ: 10,
			meshId: source.id,
			position: [0, 0, -50],
			normal: [0, 0, -1],
			materialId: material.id,
			alphaIndex: 8,
			renderingGroupId: 0,
			vertexCount: expect.any(Number),
			indexCount: expect.any(Number),
			deferredCameras: expect.arrayContaining([
				expect.objectContaining({ active: false, errors: expect.arrayContaining([expect.stringContaining("set of deferred meshes changed")]) }),
			]),
		});

		stopDeferredLighting(scene, camera);
		expect(configureDeferredLighting(scene, camera)).toMatchObject({
			active: true,
			decalActive: true,
			decalCount: 1,
			decalSources: [expect.objectContaining({ nodeId: created.node.id, sourceMeshId: source.id, materialId: material.id, alphaMode: "alpha-blend" })],
		});
		expect(getDecal(scene, { nodeId: created.node.id })).toMatchObject({
			revision: 1,
			deferredCameras: [expect.objectContaining({ active: true, decalCount: 1 })],
		});
		expect(listDecals(scene, { search: "IMPACT", offset: 0, limit: 1 })).toMatchObject({
			totalCount: 1,
			count: 1,
			hasMore: false,
			nextOffset: null,
			decals: [expect.objectContaining({ revision: 1, node: expect.objectContaining({ id: created.node.id }) })],
			deferredCameras: [expect.objectContaining({ decalCount: 1 })],
		});

		expect(() => setDecal(scene, { nodeId: created.node.id, expectedRevision: 2, angle: 0.5 }, options)).toThrow("revision is stale");
		expect(getDecal(scene, { nodeId: created.node.id }).revision).toBe(1);
		const updated = setDecal(
			scene,
			{ nodeId: created.node.id, expectedRevision: 1, name: "Impact Decal Updated", position: [5, 0, -50], normal: null, size: [60, 50, 10], angle: 0.5, alphaIndex: 9 },
			options
		);
		expect(updated).toMatchObject({
			revision: 2,
			angle: 0.5,
			position: [5, 0, -50],
			normal: null,
			sizeX: 60,
			alphaIndex: 9,
			node: { name: "Impact Decal Updated" },
			deferredCameras: expect.arrayContaining([
				expect.objectContaining({ active: false, errors: expect.arrayContaining([expect.stringContaining("decal projection, geometry, material channel")]) }),
			]),
		});
		const updatedMesh = scene.getMeshById(created.node.id)!;
		const updatedGeometry = updatedMesh.geometry;
		const updatedVertexCount = updatedMesh.getTotalVertices();
		expect(() => setDecal(scene, { nodeId: created.node.id, expectedRevision: 2, position: [100_000, 100_000, 100_000] }, options)).toThrow("projection did not intersect");
		expect(updatedMesh.geometry).toBe(updatedGeometry);
		expect(updatedMesh.getTotalVertices()).toBe(updatedVertexCount);
		expect(getDecal(scene, { nodeId: created.node.id })).toMatchObject({ revision: 2, position: [5, 0, -50] });
	});

	test("rejects empty projections without persisting a decal mesh", () => {
		const source = CreateBox("Missed Decal Receiver", { size: 100 }, scene);
		source.material = new StandardMaterial("Missed Receiver Material", scene);
		const material = new StandardMaterial("Missed Decal Material", scene);
		expect(() =>
			createDecal(
				scene,
				{
					sourceNodeId: source.id,
					materialId: material.id,
					name: "Missed Decal",
					position: [100_000, 100_000, 100_000],
					normal: [0, 0, -1],
					size: [10, 10, 10],
				},
				options
			)
		).toThrow("projection did not intersect");
		expect(listDecals(scene, { search: "Missed Decal" })).toMatchObject({ totalCount: 0, count: 0 });
	});

	test("creates and exact-revision updates a screen-space volume projector with deferred evidence", () => {
		const receiver = CreateBox("Volume Receiver", { size: 100 }, scene);
		receiver.layerMask = 2;
		receiver.material = new StandardMaterial("Volume Receiver Material", scene);
		const material = new StandardMaterial("Volume Projector Material", scene);
		material.diffuseColor.set(0.1, 0.7, 1);
		material.alpha = 0.6;
		expect(configureDeferredLighting(scene, camera)).toMatchObject({ active: true, decalProjectorCount: 0 });

		const created = createDecal(
			scene,
			{
				projectionMode: "screen-space-volume",
				materialId: material.id,
				name: "Volume Projector",
				position: [5, 10, 15],
				rotation: [0.1, 0.2, 0.3],
				size: [80, 60, 40],
				edgeFade: 0.25,
				uvScale: [2, 3],
				uvOffset: [0.1, -0.2],
				channels: { albedo: true, normal: true, metallic: true, ambientOcclusion: true, emissive: true },
				normalStrength: 1.4,
				metallic: 0.7,
				smoothness: 0.85,
				ambientOcclusion: 0.65,
				emissiveIntensity: 2.5,
				decalLayerMask: 2,
				alphaIndex: 7,
			},
			options
		);
		expect(created).toMatchObject({
			projectionMode: "screen-space-volume",
			version: 3,
			revision: 1,
			position: [5, 10, 15],
			rotation: [0.1, 0.2, 0.3],
			sizeX: 80,
			sizeY: 60,
			sizeZ: 40,
			edgeFade: 0.25,
			uvScale: [2, 3],
			uvOffset: [0.1, -0.2],
			channels: { albedo: true, normal: true, metallic: true, ambientOcclusion: true, emissive: true },
			normalStrength: 1.4,
			metallic: 0.7,
			smoothness: 0.85,
			ambientOcclusion: 0.65,
			emissiveIntensity: 2.5,
			decalLayerMask: 2,
			meshId: null,
			vertexCount: 0,
			indexCount: 0,
		});
		expect(scene.getMeshById(created.node.id)).toMatchObject({ isVisible: false, alphaIndex: 7 });
		expect(created.deferredCameras).toEqual([expect.objectContaining({ active: false, errors: expect.arrayContaining([expect.stringContaining("decal projection")]) })]);

		stopDeferredLighting(scene, camera);
		const runtime = configureDeferredLighting(scene, camera);
		expect(runtime).toMatchObject({
			active: true,
			decalCount: 1,
			decalGeometryCount: 0,
			decalProjectorCount: 1,
			decalProjectorMaximumSources: 8,
			decalProjectorSamplerCount: 1,
			decalLayerFilteredProjectorCount: 1,
			decalLayerTargetReady: false,
			decalSources: [
				expect.objectContaining({
					backend: "screen-space-volume-projector-v2",
					projectionMode: "screen-space-volume",
					nodeId: created.node.id,
					edgeFade: 0.25,
					uvScale: [2, 3],
					channels: { albedo: true, normal: true, metallic: true, ambientOcclusion: true, emissive: true },
					decalLayerMask: 2,
					affectsAmbientOcclusion: true,
					affectedMeshCount: 1,
					geometryReady: true,
				}),
			],
		});

		expect(() => setDecal(scene, { nodeId: created.node.id, expectedRevision: 2, edgeFade: 0.5 }, options)).toThrow("revision is stale");
		expect(() => setDecal(scene, { nodeId: created.node.id, expectedRevision: 1, sourceNodeId: receiver.id }, options)).toThrow("do not use sourceNodeId");
		expect(() =>
			setDecal(
				scene,
				{ nodeId: created.node.id, expectedRevision: 1, channels: { albedo: false, normal: false, metallic: false, ambientOcclusion: false, emissive: false } },
				options
			)
		).toThrow("must enable at least one");
		const updated = setDecal(
			scene,
			{
				nodeId: created.node.id,
				expectedRevision: 1,
				position: [-5, 20, 25],
				rotation: [0.4, 0.5, 0.6],
				size: [90, 70, 50],
				edgeFade: 0.5,
				uvScale: [1.5, 1.25],
				uvOffset: [0.2, 0.3],
				channels: { normal: false, emissive: false },
				normalStrength: 0.6,
				metallic: 0.25,
				smoothness: 0.4,
				ambientOcclusion: 0.9,
				emissiveIntensity: 1.5,
				decalLayerMask: 6,
				alphaIndex: 9,
			},
			options
		);
		expect(updated).toMatchObject({
			revision: 2,
			position: [-5, 20, 25],
			rotation: [0.4, 0.5, 0.6],
			sizeX: 90,
			sizeY: 70,
			sizeZ: 50,
			edgeFade: 0.5,
			uvScale: [1.5, 1.25],
			uvOffset: [0.2, 0.3],
			channels: { albedo: true, normal: false, metallic: true, ambientOcclusion: true, emissive: false },
			normalStrength: 0.6,
			metallic: 0.25,
			smoothness: 0.4,
			ambientOcclusion: 0.9,
			emissiveIntensity: 1.5,
			decalLayerMask: 6,
			alphaIndex: 9,
			deferredCameras: [expect.objectContaining({ active: false, errors: expect.arrayContaining([expect.stringContaining("decal projection")]) })],
		});
		expect(listDecals(scene, { search: "volume projector" })).toMatchObject({ totalCount: 1, decals: [expect.objectContaining({ revision: 2 })] });
	});
});

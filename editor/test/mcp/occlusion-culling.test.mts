import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, SceneSerializer, StandardMaterial, Vector3 } from "babylonjs";

import {
	bakeOcclusionCullingAction,
	cancelOcclusionCullingBake,
	clearOcclusionCullingBake,
	createOcclusionCullingArea,
	deleteOcclusionCullingArea,
	getOcclusionCulling,
	getOcclusionCullingCapabilities,
	getOcclusionCullingRuntime,
	inspectOcclusionCullingBake,
	resetOcclusionCulling,
	setCameraOcclusionCulling,
	setOcclusionCullingMesh,
	setOcclusionCullingSettings,
	setOcclusionCullingVisualization,
	updateOcclusionCullingArea,
} from "../../src/mcp/rendering/occlusion-culling";

describe("mcp/occlusion-culling", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;
	const options = { editor: { layout: { inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() } } } } as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		camera = new FreeCamera("Game Camera", new Vector3(-500, 0, 0), scene);
		scene.activeCamera = camera;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
		vi.clearAllMocks();
	});

	function createBlockedRoom(): { wallId: string; targetId: string } {
		const wall = MeshBuilder.CreateBox("Wall", { width: 50, height: 2_000, depth: 2_000 }, scene);
		const target = MeshBuilder.CreateBox("Treasure", { size: 100 }, scene);
		target.position.x = 500;
		return { wallId: wall.id, targetId: target.id };
	}

	function authorBakeInputs(wallId: string, targetId: string): number {
		let revision = 0;
		revision = setOcclusionCullingSettings(
			scene,
			{
				expectedRevision: revision,
				settings: { cellSize: 200, viewSamples: 1, targetSamples: 1, maximumCells: 64, maximumRayTests: 50_000, maximumRelationships: 10_000 },
			},
			options
		).revision;
		revision = setOcclusionCullingMesh(
			scene,
			{ meshId: wallId, expectedRevision: revision, expectedObjectRevision: 0, settings: { staticOccluder: true } },
			options
		).configurationRevision;
		revision = setOcclusionCullingMesh(
			scene,
			{ meshId: targetId, expectedRevision: revision, expectedObjectRevision: 0, settings: { staticOccludee: true } },
			options
		).configurationRevision;
		return createOcclusionCullingArea(
			scene,
			{ expectedRevision: revision, id: "left-room", name: "Left Room", center: [-500, 0, 0], size: [100, 100, 100], isViewVolume: true, enabled: true },
			options
		).configurationRevision;
	}

	test("authors mesh, camera, settings, and exact-revision Occlusion Areas", () => {
		const { wallId, targetId } = createBlockedRoom();
		const revision = authorBakeInputs(wallId, targetId);
		const authored = getOcclusionCulling(scene, { offset: 0, limit: 10 });
		expect(authored).toMatchObject({ authored: true, configuration: { revision, areas: [{ id: "left-room", revision: 1 }] } });
		expect(authored.meshes.items.find((item: any) => item.id === wallId).settings.staticOccluder).toBe(true);
		expect(authored.meshes.items.find((item: any) => item.id === targetId).settings.staticOccludee).toBe(true);

		expect(() =>
			updateOcclusionCullingArea(scene, { areaId: "left-room", expectedRevision: revision - 1, expectedObjectRevision: 1, patch: { name: "Stale" } }, options)
		).toThrow("revision is stale");
		const updated = updateOcclusionCullingArea(
			scene,
			{ areaId: "left-room", expectedRevision: revision, expectedObjectRevision: 1, patch: { name: "Playable Room", size: [150, 100, 100] } },
			options
		);
		const cameraUpdate = setCameraOcclusionCulling(
			scene,
			{ cameraId: camera.id, expectedRevision: updated.configurationRevision, expectedObjectRevision: 0, enabled: false },
			options
		);
		expect(cameraUpdate.camera.settings).toMatchObject({ revision: 1, enabled: false });
		expect(() =>
			deleteOcclusionCullingArea(scene, { areaId: "left-room", expectedRevision: cameraUpdate.configurationRevision, expectedObjectRevision: 2, confirm: false }, options)
		).toThrow("confirm=true");
		expect(
			deleteOcclusionCullingArea(scene, { areaId: "left-room", expectedRevision: cameraUpdate.configurationRevision, expectedObjectRevision: 2, confirm: true }, options)
		).toMatchObject({ deleted: true, name: "Playable Room" });
		expect(options.editor.layout.inspector.forceUpdate).toHaveBeenCalled();
	});

	test("pages large mesh and camera collections independently without eagerly reading off-page objects", () => {
		for (let index = 0; index < 505; index++) {
			new Mesh(`Mesh ${index}`, scene);
			new FreeCamera(`Camera ${index}`, Vector3.Zero(), scene);
		}
		const lastMesh = scene.meshes.at(-1)!;
		const lastCamera = scene.cameras.at(-1)!;
		scene.meshes[0].metadata = { babylonEditorOcclusionCulling: { invalid: true } };

		const page = getOcclusionCulling(scene, {
			offset: scene.meshes.indexOf(lastMesh),
			limit: 1,
			cameraOffset: scene.cameras.indexOf(lastCamera),
			cameraLimit: 1,
		});
		expect(page.meshes).toMatchObject({ total: 505, limit: 1, items: [{ id: lastMesh.id }] });
		expect(page.cameras).toMatchObject({ total: 506, limit: 1, items: [{ id: lastCamera.id }] });
	});

	test("leases, bakes, visualizes, runs, restores visibility, and clears exact bake data", async () => {
		const { wallId, targetId } = createBlockedRoom();
		const revision = authorBakeInputs(wallId, targetId);
		const plan = await inspectOcclusionCullingBake(scene, { expectedRevision: revision });
		expect(plan).toMatchObject({ occluderMeshIds: [wallId], occludeeMeshIds: [targetId] });
		const result = await bakeOcclusionCullingAction(scene, { expectedRevision: revision, expectedSourceFingerprint: plan.sourceFingerprint }, options);
		expect(result.job).toMatchObject({ status: "completed", sourceFingerprint: plan.sourceFingerprint });
		expect(result.bake.cells[0].occludedMeshIds).toEqual([targetId]);

		const visualization = setOcclusionCullingVisualization(scene, {
			enabled: true,
			showCells: true,
			showVisible: true,
			showOccluded: true,
			selectedCellId: result.bake.cells[0].id,
		});
		expect(visualization.lineCount).toBeGreaterThan(0);
		expect(scene.meshes.some((mesh) => mesh.metadata?.babylonEditorOcclusionCullingVisualization)).toBe(true);

		scene.onBeforeCameraRenderObservable.notifyObservers(camera);
		expect(scene.getMeshById(targetId)?.isVisible).toBe(false);
		expect(getOcclusionCullingRuntime(scene).cameras[0].bakedCulledMeshIds).toEqual([targetId]);
		scene.onAfterCameraRenderObservable.notifyObservers(camera);
		expect(scene.getMeshById(targetId)?.isVisible).toBe(true);

		expect(() =>
			clearOcclusionCullingBake(scene, { expectedRevision: result.configurationRevision, expectedBakeFingerprint: result.bake.bakeFingerprint, confirm: false }, options)
		).toThrow("confirm=true");
		expect(() => clearOcclusionCullingBake(scene, { expectedRevision: result.configurationRevision, expectedBakeFingerprint: "0".repeat(64), confirm: true }, options)).toThrow(
			"fingerprint is stale"
		);
		expect(
			clearOcclusionCullingBake(scene, { expectedRevision: result.configurationRevision, expectedBakeFingerprint: result.bake.bakeFingerprint, confirm: true }, options)
		).toMatchObject({ cleared: true });
		expect(getOcclusionCulling(scene).bakeStatus.present).toBe(false);
	});

	test("rejects stale source leases without publishing partial output", async () => {
		const { wallId, targetId } = createBlockedRoom();
		const revision = authorBakeInputs(wallId, targetId);
		const plan = await inspectOcclusionCullingBake(scene, { expectedRevision: revision });
		scene.getMeshById(wallId)!.position.y = 25;
		await expect(bakeOcclusionCullingAction(scene, { expectedRevision: revision, expectedSourceFingerprint: plan.sourceFingerprint }, options)).rejects.toThrow(
			"source fingerprint is stale"
		);
		expect(getOcclusionCulling(scene).configuration.bake).toBeUndefined();
	});

	test("keeps an exact cancellation lease stable while bounded bake progress streams", async () => {
		const { wallId, targetId } = createBlockedRoom();
		let revision = authorBakeInputs(wallId, targetId);
		revision = setOcclusionCullingSettings(
			scene,
			{
				expectedRevision: revision,
				settings: { cellSize: 10, maximumCells: 1_000, maximumRayTests: 50_000, maximumRelationships: 10_000 },
			},
			options
		).revision;
		revision = updateOcclusionCullingArea(
			scene,
			{ areaId: "left-room", expectedRevision: revision, expectedObjectRevision: 1, patch: { size: [100, 100, 100] } },
			options
		).configurationRevision;
		const plan = await inspectOcclusionCullingBake(scene, { expectedRevision: revision });
		expect(plan.cells).toHaveLength(1_000);

		const bakePromise = bakeOcclusionCullingAction(scene, { expectedRevision: revision, expectedSourceFingerprint: plan.sourceFingerprint }, options);
		const rejection = expect(bakePromise).rejects.toThrow("cancelled before publication");
		await vi.waitFor(() => expect(getOcclusionCulling(scene).job?.progress.completedCells).toBeGreaterThan(0));
		const running = getOcclusionCulling(scene).job;
		expect(running).toMatchObject({ status: "running", revision: 1 });
		expect(cancelOcclusionCullingBake(scene, { id: running.id, expectedJobRevision: running.revision })).toMatchObject({ cancelRequested: true, revision: 2 });
		await rejection;
		const cancelled = getOcclusionCulling(scene);
		expect(cancelled.configuration.bake).toBeUndefined();
		expect(cancelled.job).toMatchObject({ status: "cancelled", revision: 3 });
	});

	test("rejects non-opaque occluders before mutation and reports explicit capability boundaries", async () => {
		const { wallId, targetId } = createBlockedRoom();
		const material = new StandardMaterial("Glass", scene);
		material.alpha = 0.5;
		scene.getMeshById(wallId)!.material = material;
		const revision = authorBakeInputs(wallId, targetId);
		await expect(inspectOcclusionCullingBake(scene, { expectedRevision: revision })).rejects.toThrow("enabled opaque Static Occluder");
		expect(getOcclusionCullingCapabilities(scene)).toMatchObject({
			features: { staticOccluders: true, bakedPotentiallyVisibleSets: true, babylonHardwareQueries: true },
			boundaries: expect.arrayContaining([expect.stringContaining("Unity/Umbra")]),
		});
	});

	test("serializes authored bake data while excluding transient visualization", async () => {
		const { wallId, targetId } = createBlockedRoom();
		const revision = authorBakeInputs(wallId, targetId);
		const plan = await inspectOcclusionCullingBake(scene, { expectedRevision: revision });
		const result = await bakeOcclusionCullingAction(scene, { expectedRevision: revision, expectedSourceFingerprint: plan.sourceFingerprint }, options);
		setOcclusionCullingVisualization(scene, { enabled: true, selectedCellId: result.bake.cells[0].id });

		const serialized = SceneSerializer.Serialize(scene) as any;
		expect(serialized.metadata.babylonEditorOcclusionCulling.bake.bakeFingerprint).toBe(result.bake.bakeFingerprint);
		expect(serialized.meshes.some((mesh: any) => mesh.metadata?.babylonEditorOcclusionCullingVisualization)).toBe(false);
	});

	test("confirmation-gated reset removes all authored and transient state", async () => {
		const { wallId, targetId } = createBlockedRoom();
		const revision = authorBakeInputs(wallId, targetId);
		const plan = await inspectOcclusionCullingBake(scene, { expectedRevision: revision });
		const baked = await bakeOcclusionCullingAction(scene, { expectedRevision: revision, expectedSourceFingerprint: plan.sourceFingerprint }, options);
		setOcclusionCullingVisualization(scene, { enabled: true, selectedCellId: baked.bake.cells[0].id });
		expect(() => resetOcclusionCulling(scene, { expectedRevision: baked.configurationRevision, confirm: false }, options)).toThrow("confirm=true");
		expect(resetOcclusionCulling(scene, { expectedRevision: baked.configurationRevision, confirm: true }, options)).toMatchObject({
			reset: true,
			removedMeshSettings: 2,
			removedBake: true,
		});
		const clean = getOcclusionCulling(scene);
		expect(clean.authored).toBe(false);
		expect(clean.configuration).toMatchObject({ revision: 0, bakeRevision: 0, areas: [] });
		expect(scene.meshes.some((mesh) => mesh.metadata?.babylonEditorOcclusionCullingVisualization)).toBe(false);
	});
});

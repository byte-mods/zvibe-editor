import "@babylonjs/core/Loading/Plugins/babylonFileLoader";

import { Buffer } from "node:buffer";

import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { SceneSerializer } from "@babylonjs/core/Misc/sceneSerializer";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { afterEach, describe, expect, it } from "vitest";

import {
	bakeOcclusionCulling,
	configureOcclusionCulling,
	createDefaultOcclusionCullingConfiguration,
	getOcclusionCullingMeshSignature,
	inspectOcclusionCullingBake,
	normalizeOcclusionCullingConfiguration,
	occlusionCullingMetadataKey,
	occlusionCullingObjectMetadataKey,
	occlusionCullingSetsMetadataKey,
} from "../../src/loading/occlusion-culling";
import { loadSceneAdditive, unloadSceneAdditive } from "../../src/loading/additive-scene";

const scenes: Scene[] = [];

function createScene(): Scene {
	const scene = new Scene(new NullEngine({ renderWidth: 320, renderHeight: 180, textureSize: 256, deterministicLockstep: false, lockstepMaxSteps: 4 }));
	scenes.push(scene);
	return scene;
}

function flag(mesh: AbstractMesh, settings: Partial<Record<string, unknown>>): void {
	mesh.metadata ??= {};
	mesh.metadata[occlusionCullingObjectMetadataKey] = {
		version: 1,
		revision: 1,
		staticOccluder: false,
		staticOccludee: false,
		dynamicOcclusion: false,
		queryMode: "optimistic",
		queryRetryCount: 2,
		forceRenderingWhenOccluded: false,
		...settings,
	};
}

function configuration(scene: Scene, patch: Partial<Record<string, unknown>> = {}): any {
	const value = createDefaultOcclusionCullingConfiguration();
	value.revision = 1;
	value.bakeRevision = 1;
	value.settings = {
		...value.settings,
		cellSize: 200,
		viewSamples: 1,
		targetSamples: 1,
		maximumCells: 64,
		maximumRayTests: 50_000,
		maximumRelationships: 10_000,
	};
	value.areas = [
		{
			version: 1,
			revision: 1,
			id: "left-room",
			name: "Left Room",
			center: [-500, 0, 0],
			size: [100, 100, 100],
			isViewVolume: true,
			enabled: true,
		},
	];
	Object.assign(value, patch);
	scene.metadata ??= {};
	scene.metadata[occlusionCullingMetadataKey] = value;
	return value;
}

function attachEmptyBake(value: any, hashCharacter: string): void {
	value.bake = {
		version: 1,
		model: "bounded-static-pvs-ray-bake-v1",
		configurationBakeRevision: value.bakeRevision,
		sourceFingerprint: hashCharacter.repeat(64),
		bakeFingerprint: hashCharacter.repeat(64),
		createdAt: new Date(0).toISOString(),
		sources: [],
		cells: [],
		warnings: [],
		statistics: {
			areaCount: value.areas.length,
			cellCount: 0,
			validCellCount: 0,
			invalidCellCount: 0,
			sourceMeshCount: 0,
			occluderCount: 0,
			occludeeCount: 0,
			visibleRelationships: 0,
			occludedRelationships: 0,
			rayTests: 0,
			durationMilliseconds: 0,
		},
	};
}

afterEach(() => {
	while (scenes.length) {
		const scene = scenes.pop()!;
		const engine = scene.getEngine();
		scene.dispose();
		engine.dispose();
	}
});

describe("occlusion culling", () => {
	it("bakes a blocked room target and restores authored visibility after each camera", async () => {
		const scene = createScene();
		const wall = MeshBuilder.CreateBox("wall", { width: 50, height: 2_000, depth: 2_000 }, scene);
		const target = MeshBuilder.CreateBox("target", { size: 100 }, scene);
		target.position.x = 500;
		flag(wall, { staticOccluder: true });
		flag(target, { staticOccludee: true });
		const value = configuration(scene);

		const plan = await inspectOcclusionCullingBake(scene, value);
		expect(plan.occluderMeshIds).toEqual([wall.id]);
		expect(plan.occludeeMeshIds).toEqual([target.id]);
		expect(plan.estimatedRayTests).toBeLessThanOrEqual(value.settings.maximumRayTests);

		value.bake = await bakeOcclusionCulling(scene, value);
		expect(value.bake.cells).toHaveLength(1);
		expect(value.bake.cells[0].occludedMeshIds).toEqual([target.id]);
		expect(value.bake.statistics.occludedRelationships).toBe(1);

		const camera = new FreeCamera("game-camera", new Vector3(-500, 0, 0), scene);
		scene.activeCamera = camera;
		const runtime = configureOcclusionCulling(scene)!;
		scene.onBeforeCameraRenderObservable.notifyObservers(camera);
		expect(target.isVisible).toBe(false);
		expect(runtime.getState().cameras[0].bakedCulledMeshIds).toEqual([target.id]);
		scene.onAfterCameraRenderObservable.notifyObservers(camera);
		expect(target.isVisible).toBe(true);

		wall.position.y = 50;
		scene.onBeforeCameraRenderObservable.notifyObservers(camera);
		expect(target.isVisible).toBe(true);
		expect(runtime.getState().cameras[0].staleReason).toContain("changed after baking");
	});

	it("uses Smallest Hole as an actual clearance bundle instead of a single center ray", async () => {
		const scene = createScene();
		const upper = MeshBuilder.CreateBox("upper", { width: 50, height: 950, depth: 2_000 }, scene);
		upper.position.y = 525;
		const lower = MeshBuilder.CreateBox("lower", { width: 50, height: 950, depth: 2_000 }, scene);
		lower.position.y = -525;
		const target = MeshBuilder.CreateBox("target", { size: 50 }, scene);
		target.position.x = 500;
		flag(upper, { staticOccluder: true });
		flag(lower, { staticOccluder: true });
		flag(target, { staticOccludee: true });
		const value = configuration(scene);

		value.settings.smallestHole = 20;
		const openBake = await bakeOcclusionCulling(scene, value);
		expect(openBake.cells[0].visibleMeshIds).toContain(target.id);

		value.settings.smallestHole = 300;
		value.bakeRevision++;
		const closedBake = await bakeOcclusionCulling(scene, value);
		expect(closedBake.cells[0].occludedMeshIds).toContain(target.id);
	});

	it("marks an inside-out camera cell invalid under Backface Threshold and never culls from it", async () => {
		const scene = createScene();
		const enclosure = MeshBuilder.CreateBox("enclosure", { size: 1_000 }, scene);
		const target = MeshBuilder.CreateBox("target", { size: 50 }, scene);
		target.position.x = 2_000;
		flag(enclosure, { staticOccluder: true });
		flag(target, { staticOccludee: true });
		const value = configuration(scene);
		value.areas[0].center = [0, 0, 0];
		value.settings.backfaceThreshold = 0;

		const bake = await bakeOcclusionCulling(scene, value);
		expect(bake.cells[0].valid).toBe(false);
		expect(bake.cells[0].backfacePercent).toBeGreaterThan(0);
		expect(bake.cells[0].visibleMeshIds).toContain(target.id);
		expect(bake.cells[0].occludedMeshIds).toEqual([]);
	});

	it("rejects transparent-only occluders and excessive work before mutating metadata", async () => {
		const scene = createScene();
		const wall = MeshBuilder.CreateBox("glass", { size: 500 }, scene);
		const material = new StandardMaterial("glass-material", scene);
		material.alpha = 0.5;
		wall.material = material;
		const target = MeshBuilder.CreateBox("target", { size: 50 }, scene);
		target.position.x = 1_000;
		flag(wall, { staticOccluder: true });
		flag(target, { staticOccludee: true });
		const value = configuration(scene);
		const before = structuredClone(value);

		await expect(inspectOcclusionCullingBake(scene, value)).rejects.toThrow("enabled opaque Static Occluder");
		expect(value).toEqual(before);

		material.alpha = 1;
		value.settings.maximumRayTests = 1;
		await expect(inspectOcclusionCullingBake(scene, value)).rejects.toThrow("above the authored 1 limit");
	});

	it("strictly rejects unknown persisted fields and produces transform-sensitive source signatures", () => {
		const scene = createScene();
		const mesh = MeshBuilder.CreateBox("source", { size: 100 }, scene);
		const first = getOcclusionCullingMeshSignature(mesh);
		mesh.position.x = 1;
		const second = getOcclusionCullingMeshSignature(mesh);
		expect(second).not.toBe(first);

		const value = createDefaultOcclusionCullingConfiguration() as any;
		value.unknown = true;
		expect(() => normalizeOcclusionCullingConfiguration(value)).toThrow("unknown field");
	});

	it("configures and restores Babylon native occlusion query policy for dynamic occludees", () => {
		const scene = createScene();
		(scene.getEngine().getCaps() as any).supportOcclusionQuery = true;
		const mesh = MeshBuilder.CreateBox("dynamic", { size: 100 }, scene);
		flag(mesh, { dynamicOcclusion: true, queryMode: "strict", queryRetryCount: 7, forceRenderingWhenOccluded: true });
		const original = {
			type: mesh.occlusionType,
			retries: mesh.occlusionRetryCount,
			force: mesh.forceRenderingWhenOccluded,
		};
		configuration(scene);

		const runtime = configureOcclusionCulling(scene)!;
		expect(mesh.occlusionType).toBe(AbstractMesh.OCCLUSION_TYPE_STRICT);
		expect(mesh.occlusionRetryCount).toBe(7);
		expect(mesh.forceRenderingWhenOccluded).toBe(true);
		expect(runtime.getState().dynamicQueryMeshIds).toEqual([mesh.id]);

		runtime.dispose();
		expect(mesh.occlusionType).toBe(original.type);
		expect(mesh.occlusionRetryCount).toBe(original.retries);
		expect(mesh.forceRenderingWhenOccluded).toBe(original.force);
	});

	it("retains independent full and additive configuration sets and restores the base owner on unload", async () => {
		const scene = createScene();
		const base = configuration(scene);
		base.areas[0].id = "base-room";
		base.areas[0].name = "Base Room";
		attachEmptyBake(base, "a");
		const baseRuntime = configureOcclusionCulling(scene)!;
		expect(baseRuntime.getState().configurationCount).toBe(1);

		const source = createScene();
		const additive = configuration(source);
		additive.revision = 7;
		additive.bakeRevision = 7;
		additive.areas[0].id = "additive-room";
		additive.areas[0].name = "Additive Room";
		attachEmptyBake(additive, "b");
		const mesh = MeshBuilder.CreateBox("additive-occludee", { size: 100 }, source);
		mesh.id = "additive-occludee";
		flag(mesh, { staticOccludee: true });
		const serialized = SceneSerializer.Serialize(source);
		const dataUrl = `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;

		const handle = await loadSceneAdditive("", dataUrl, scene, {});
		expect(scene.metadata?.[occlusionCullingSetsMetadataKey]).toHaveLength(2);
		expect(scene.occlusionCulling?.getState()).toMatchObject({ configurationCount: 2 });
		expect(scene.getMeshById("additive-occludee")).not.toBeNull();

		await unloadSceneAdditive(handle);
		expect(scene.metadata?.[occlusionCullingSetsMetadataKey]).toBeUndefined();
		expect(scene.metadata?.[occlusionCullingMetadataKey].areas[0].id).toBe("base-room");
		expect(scene.occlusionCulling?.getState()).toMatchObject({ configurationCount: 1 });
		expect(scene.getMeshById("additive-occludee")).toBeNull();
	});
});

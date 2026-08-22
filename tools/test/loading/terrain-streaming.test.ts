import { describe, expect, test } from "vitest";

import { createHash } from "node:crypto";

import { FreeCamera, Mesh, MeshBuilder, NullEngine, Scene, Vector3 } from "@babylonjs/core";

import { configureTerrainStreaming, configureTerrainStreamingExport, ITerrainStreamingBinaryInfo } from "../../src/loading/terrain-streaming";

function createTerrainBinary(): { bytes: Buffer; binaryInfo: ITerrainStreamingBinaryInfo; hash: string } {
	const positions = new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5]);
	const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
	const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
	const indices = new Int32Array([0, 1, 2, 0, 2, 3]);
	const subMeshes = new Int32Array([0, 0, 4, 0, 6]);
	const chunks = [Buffer.from(positions.buffer), Buffer.from(normals.buffer), Buffer.from(uvs.buffer), Buffer.from(indices.buffer), Buffer.from(subMeshes.buffer)];
	const offsets = chunks.reduce<number[]>((result, _chunk, index) => [...result, index ? result[index - 1] + chunks[index - 1].byteLength : 0], []);
	const bytes = Buffer.concat(chunks);
	return {
		bytes,
		hash: createHash("sha256").update(bytes).digest("hex"),
		binaryInfo: {
			positionsAttrDesc: { count: positions.length, stride: 3, offset: offsets[0], dataType: 1 },
			normalsAttrDesc: { count: normals.length, stride: 3, offset: offsets[1], dataType: 1 },
			uvsAttrDesc: { count: uvs.length, stride: 2, offset: offsets[2], dataType: 1 },
			indicesAttrDesc: { count: indices.length, stride: 1, offset: offsets[3], dataType: 0 },
			subMeshesAttrDesc: { count: 1, stride: 5, offset: offsets[4], dataType: 0 },
		},
	};
}

describe("loading/terrain-streaming", () => {
	test("activates only Ground tiles near the active camera in exported runtime", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		const near = MeshBuilder.CreateGround("Near", { width: 10, height: 10 }, scene);
		const far = MeshBuilder.CreateGround("Far", { width: 10, height: 10 }, scene);
		far.position.x = 100;
		scene.metadata = { babylonEditorTerrainStreamingGroups: [{ terrainIds: [near.id, far.id], distance: 50, enabled: true }] };

		configureTerrainStreaming(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);

		expect(near.isEnabled()).toBe(true);
		expect(far.isEnabled()).toBe(false);
		camera.position.x = 100;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(near.isEnabled()).toBe(false);
		expect(far.isEnabled()).toBe(true);
		scene.dispose();
		engine.dispose();
	});

	test("releases and restores already-loaded terrain geometry when configured", () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		const near = MeshBuilder.CreateGround("Near", { width: 10, height: 10 }, scene);
		const far = MeshBuilder.CreateGround("Far", { width: 10, height: 10 }, scene);
		far.position.x = 100;
		scene.metadata = { babylonEditorTerrainStreamingGroups: [{ terrainIds: [near.id, far.id], distance: 50, enabled: true, releaseGeometry: true }] };

		configureTerrainStreaming(scene);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(far.getTotalVertices()).toBe(0);
		camera.position.x = 100;
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(far.isEnabled()).toBe(true);
		expect(far.getTotalVertices()).toBeGreaterThan(0);
		scene.dispose();
		engine.dispose();
	});

	test("fetches, verifies, decodes, unloads, and reloads remote geometry asynchronously", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		const camera = new FreeCamera("Camera", Vector3.Zero(), scene);
		scene.activeCamera = camera;
		const tile = new Mesh("Remote Tile", scene);
		const artifact = createTerrainBinary();
		let now = 0;
		let fetchCount = 0;
		scene.metadata = {
			babylonEditorTerrainStreamingGroups: [
				{
					version: 2,
					id: "remote",
					terrainIds: [tile.id],
					distance: 50,
					preloadDistance: 75,
					unloadDistance: 100,
					unloadDelayMs: 25,
					enabled: true,
					streamGeometry: true,
					tiles: [
						{
							terrainId: tile.id,
							url: "world/tile.binary",
							sha256: artifact.hash,
							byteLength: artifact.bytes.byteLength,
							binaryInfo: artifact.binaryInfo,
						},
					],
				},
			],
		};
		const runtime = configureTerrainStreaming(scene, "/scene/", {
			now: () => now,
			fetch: (async (url: string | URL | Request) => {
				fetchCount++;
				expect(String(url)).toBe("/scene/world/tile.binary");
				return new Response(Uint8Array.from(artifact.bytes));
			}) as typeof fetch,
		})!;

		await runtime.updateAsync();
		expect(fetchCount).toBe(1);
		expect(tile.getTotalVertices()).toBe(4);
		expect(tile.getTotalIndices()).toBe(6);
		expect(tile.subMeshes).toHaveLength(1);
		expect(tile.isEnabled()).toBe(true);
		expect(runtime.getState().tiles[0]).toMatchObject({ status: "loaded", bytesLoaded: artifact.bytes.byteLength, verified: true, error: null });

		camera.position.x = 125;
		now = 10;
		await runtime.updateAsync();
		expect(tile.getTotalVertices()).toBe(4);
		now = 40;
		await runtime.updateAsync();
		expect(tile.getTotalVertices()).toBe(0);
		expect(tile.isEnabled()).toBe(false);

		camera.position.x = 0;
		now = 50;
		await runtime.updateAsync();
		expect(fetchCount).toBe(2);
		expect(tile.getTotalVertices()).toBe(4);
		expect(runtime.getState().tiles[0].attempts).toBe(2);
		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("rejects corrupted remote bytes without publishing geometry", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Camera", Vector3.Zero(), scene);
		const tile = new Mesh("Corrupt Tile", scene);
		const artifact = createTerrainBinary();
		scene.metadata = {
			babylonEditorTerrainStreamingGroups: [
				{
					id: "corrupt",
					terrainIds: [tile.id],
					distance: 50,
					enabled: true,
					streamGeometry: true,
					retryCount: 0,
					tiles: [
						{
							terrainId: tile.id,
							url: "corrupt.binary",
							sha256: "0".repeat(64),
							byteLength: artifact.bytes.byteLength,
							binaryInfo: artifact.binaryInfo,
						},
					],
				},
			],
		};
		const runtime = configureTerrainStreaming(scene, "", { fetch: (async () => new Response(Uint8Array.from(artifact.bytes))) as typeof fetch })!;
		await runtime.updateAsync();

		expect(tile.getTotalVertices()).toBe(0);
		expect(runtime.getState().tiles[0]).toMatchObject({ status: "error", verified: false, error: "SHA-256 verification failed." });
		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("loads and shows every exported placeholder while a remote group is disabled", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Camera", Vector3.Zero(), scene);
		const tile = new Mesh("Disabled Remote Tile", scene);
		tile.position.x = 1000;
		const artifact = createTerrainBinary();
		scene.metadata = {
			babylonEditorTerrainStreamingGroups: [
				{
					id: "disabled-remote",
					terrainIds: [tile.id],
					distance: 10,
					preloadDistance: 20,
					unloadDistance: 30,
					enabled: false,
					streamGeometry: true,
					tiles: [
						{
							terrainId: tile.id,
							url: "disabled.binary",
							sha256: artifact.hash,
							byteLength: artifact.bytes.byteLength,
							binaryInfo: artifact.binaryInfo,
						},
					],
				},
			],
		};
		const runtime = configureTerrainStreaming(scene, "", { fetch: (async () => new Response(Uint8Array.from(artifact.bytes))) as typeof fetch })!;
		await runtime.updateAsync();

		expect(tile.getTotalVertices()).toBe(4);
		expect(tile.isEnabled()).toBe(true);
		expect(runtime.getState().tiles[0]).toMatchObject({ status: "loaded", verified: true });
		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("keeps full-scene and additive-scene artifact roots isolated", async () => {
		const engine = new NullEngine();
		const scene = new Scene(engine);
		scene.activeCamera = new FreeCamera("Camera", Vector3.Zero(), scene);
		const baseTile = new Mesh("Base Tile", scene);
		const additiveTile = new Mesh("Additive Tile", scene);
		const artifact = createTerrainBinary();
		const fetchedUrls: string[] = [];
		const createGroup = (id: string, terrainId: string, url: string): any => ({
			version: 2,
			id,
			terrainIds: [terrainId],
			distance: 50,
			enabled: true,
			streamGeometry: true,
			tiles: [{ terrainId, url, sha256: artifact.hash, byteLength: artifact.bytes.byteLength, binaryInfo: artifact.binaryInfo }],
		});
		scene.metadata = { babylonEditorTerrainStreamingGroups: [createGroup("base", baseTile.id, "tiles/base.binary")] };
		const runtime = configureTerrainStreaming(scene, "/base-scene/", {
			fetch: (async (url: string | URL | Request) => {
				fetchedUrls.push(String(url));
				return new Response(Uint8Array.from(artifact.bytes));
			}) as typeof fetch,
		})!;

		await runtime.updateAsync();
		(scene.metadata.babylonEditorTerrainStreamingGroups as any[]).push(createGroup("additive", additiveTile.id, "tiles/additive.binary"));
		configureTerrainStreaming(scene, "/additive-scene/");
		await runtime.updateAsync();

		expect(fetchedUrls).toEqual(["/base-scene/tiles/base.binary", "/additive-scene/tiles/additive.binary"]);
		expect(baseTile.getTotalVertices()).toBe(4);
		expect(additiveTile.getTotalVertices()).toBe(4);
		runtime.dispose();
		scene.dispose();
		engine.dispose();
	});

	test("turns exported streamed tiles into hashed empty placeholders without mutating authoring metadata", () => {
		const artifact = createTerrainBinary();
		const sourceGroups = [{ version: 2 as const, id: "world", terrainIds: ["tile"], distance: 100, enabled: true, streamGeometry: true }];
		const sceneData: any = {
			metadata: { babylonEditorTerrainStreamingGroups: sourceGroups },
			meshes: [{ id: "tile", geometryId: "geometry", delayLoadingFile: "world/tile.binary", _binaryInfo: artifact.binaryInfo }],
		};
		const evidence = configureTerrainStreamingExport(sceneData, [
			{ terrainId: "tile", url: "world/tile.binary", sha256: artifact.hash, byteLength: artifact.bytes.byteLength, binaryInfo: artifact.binaryInfo },
		]);

		expect(evidence).toEqual({ groupCount: 1, tileCount: 1, streamedBytes: artifact.bytes.byteLength, sharedArtifactCount: 0 });
		expect(sceneData.meshes[0]).not.toHaveProperty("delayLoadingFile");
		expect(sceneData.meshes[0]).not.toHaveProperty("_binaryInfo");
		expect(sceneData.meshes[0]).not.toHaveProperty("geometryId");
		expect(sceneData.metadata.babylonEditorTerrainStreamingGroups[0].tiles[0]).toMatchObject({ terrainId: "tile", sha256: artifact.hash });
		expect(sourceGroups[0]).not.toHaveProperty("tiles");
	});
});

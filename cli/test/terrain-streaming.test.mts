import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fs from "fs-extra";
import { afterEach, describe, expect, test } from "vitest";

import { createGeometryFiles } from "../src/pack/geometry.mjs";
import { createBabylonScene } from "../src/pack/scene.mjs";
import { ensureSceneDirectories, readSceneDirectories } from "../src/tools/scene.mjs";

describe("terrain streaming CLI export", () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
	});

	for (const mergeGeometries of [false, true]) {
		test(`publishes hashed empty placeholders with ${mergeGeometries ? "merged" : "individual"} binary geometry`, async () => {
			const root = await mkdtemp(join(tmpdir(), "zvibe-terrain-streaming-cli-"));
			temporaryDirectories.push(root);
			const sceneFile = join(root, "authoring");
			const publicDir = join(root, "public", "scene");
			await ensureSceneDirectories(sceneFile);
			await fs.ensureDir(publicDir);

			const geometry = Buffer.from(new Uint8Array(68).map((_value, index) => index));
			const binaryInfo = {
				positionsAttrDesc: { count: 9, stride: 3, offset: 0, dataType: 1 },
				indicesAttrDesc: { count: 3, stride: 1, offset: 36, dataType: 0 },
				subMeshesAttrDesc: { count: 1, stride: 5, offset: 48, dataType: 0 },
			};
			await writeFile(join(sceneFile, "geometries", "tile.babylonbinarymeshdata"), geometry);
			await fs.writeJSON(join(sceneFile, "meshes", "tile.json"), {
				meshes: [
					{
						id: "tile",
						name: "World Tile",
						metadata: { type: "Ground" },
						delayLoadingFile: "tile.babylonbinarymeshdata",
						_binaryInfo: binaryInfo,
					},
				],
			});

			const directories = await readSceneDirectories(sceneFile);
			const exportedAssets: string[] = [];
			const result = await createBabylonScene({
				buildTime: 1,
				sceneFile,
				sceneName: "world",
				publicDir,
				babylonjsEditorToolsVersion: "5.4.3",
				exportedAssets,
				optimize: false,
				compressedTexturesEnabled: false,
				mergeGeometries,
				config: {
					clearColor: [0, 0, 0, 1],
					ambientColor: [0, 0, 0],
					gravity: [0, -9.81, 0],
					fog: { fogMode: 0, fogColor: [0, 0, 0], fogStart: 0, fogEnd: 1000, fogDensity: 0 },
					physics: { gravity: [0, -9.81, 0] },
					metadata: {
						babylonEditorTerrainStreamingGroups: [
							{
								version: 2,
								revision: 1,
								id: "world-stream",
								name: "World Stream",
								terrainIds: ["tile"],
								distance: 100,
								preloadDistance: 125,
								unloadDistance: 150,
								enabled: true,
								streamGeometry: true,
							},
						],
					},
					rendering: {},
					clusteredLight: {},
					animations: [],
					environment: { environmentTexture: null, environmentIntensity: 1, iblIntensity: 1 },
				},
				directories,
			});
			await createGeometryFiles({
				sceneFile,
				sceneName: "world",
				publicDir,
				geometryFiles: result.geometryFiles,
				exportedAssets,
				babylonjsEditorToolsVersion: "5.4.3",
				mergeGeometries,
				directories,
			});

			const scene = await fs.readJSON(join(publicDir, "world.babylon"));
			const tile = scene.meshes.find((mesh: any) => mesh.id === "tile");
			const artifact = scene.metadata.babylonEditorTerrainStreamingGroups[0].tiles[0];
			const output = await readFile(join(publicDir, artifact.url));
			expect(tile).not.toHaveProperty("delayLoadingFile");
			expect(tile).not.toHaveProperty("_binaryInfo");
			expect(tile.metadata.babylonEditorTerrainStreamedPlaceholder).toMatchObject({ version: 1, groupId: "world-stream", artifact: artifact.url });
			expect(artifact).toMatchObject({
				terrainId: "tile",
				byteLength: output.byteLength,
				sha256: createHash("sha256").update(output).digest("hex"),
			});
			expect(result.usedFiles).toContain(artifact.url);
		});
	}
});

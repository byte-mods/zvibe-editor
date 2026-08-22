import { mkdir, mkdtemp, stat, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path/posix";

import { pathExists, remove } from "fs-extra";
import sharp from "sharp";
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import { DirectionalLight, Mesh, MeshBuilder, MultiMaterial, NullEngine, PBRMaterial, Scene, StandardMaterial, Vector3, VertexBuffer } from "babylonjs";

import { bakeBakedGlobalIllumination, clearBakedGlobalIllumination, getBakedGlobalIllumination } from "../../src/mcp/lights/baked-gi";
import { createLightingScenario, deleteLightingScenario, listLightingScenarios } from "../../src/mcp/lights/lights";
import { projectConfiguration } from "../../src/project/configuration";

describe("mcp/automatic baked global illumination", () => {
	let directory: string;
	let previousProjectPath: string | null;
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: {
			layout: {
				assets: { refresh: vi.fn() },
				inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() },
			},
		},
	} as any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "baked-gi-"));
		previousProjectPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
		vi.clearAllMocks();
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousProjectPath;
		await remove(directory);
	});

	test("bakes real direct lighting to a portable PNG and reversibly restores the exact runtime material", async () => {
		const material = new PBRMaterial("Original PBR", scene);
		material.id = "original-pbr";
		const ground = MeshBuilder.CreateGround("Ground", { width: 100, height: 100 }, scene);
		ground.id = "ground";
		ground.material = material;
		const sun = new DirectionalLight("Sun", new Vector3(0, -1, 0), scene);
		sun.intensity = 0.75;

		const baked = (await bakeBakedGlobalIllumination(scene, { meshIds: [ground.id], resolution: 16, samples: 1, bounces: 0, shadowing: false, dilation: 1 }, options)) as any;

		expect(baked).toMatchObject({ configured: true, backend: "bounded-cpu-one-bounce-v1", meshCount: 1, resolution: 16, bounces: 0 });
		expect(baked.totalCoveredTexels).toBeGreaterThan(0);
		expect(baked.meshEntries[0]).toMatchObject({ meshId: ground.id, originalMaterialId: material.id, uvSource: "uv0", coordinatesIndex: 0 });
		expect(ground.material).not.toBe(material);
		expect((ground.material as PBRMaterial).lightmapTexture?.coordinatesIndex).toBe(0);
		expect((ground.material as PBRMaterial).lightmapTexture?.gammaSpace).toBe(false);
		const outputPath = join(directory, baked.meshEntries[0].lightmapPath);
		expect((await stat(outputPath)).size).toBeGreaterThan(0);
		expect(await sharp(outputPath).metadata()).toMatchObject({ width: 16, height: 16, format: "png", channels: 4 });
		expect(getBakedGlobalIllumination(scene)).toMatchObject({ configured: true, bakeId: baked.bakeId });

		await expect(clearBakedGlobalIllumination(scene, { expectedBakeId: "stale", confirm: true }, options)).rejects.toThrow("changed after inspection");
		expect(ground.material?.id).toBe(baked.meshEntries[0].bakedMaterialId);

		const cleared = (await clearBakedGlobalIllumination(scene, { expectedBakeId: baked.bakeId, confirm: true }, options)) as any;
		expect(cleared).toMatchObject({ cleared: true, configured: false, restoredMeshIds: [ground.id], generatedFilesExisted: true });
		expect(ground.material).toBe(material);
		expect(await pathExists(join(directory, baked.outputDirectory))).toBe(false);
		expect(getBakedGlobalIllumination(scene)).toEqual({ configured: false, backend: "bounded-cpu-one-bounce-v1" });
		expect(options.editor.layout.assets.refresh).toHaveBeenCalledTimes(2);
	});

	test("retains generated lightmaps for captured scenarios and releases them only after the final owner is deleted", async () => {
		const original = new PBRMaterial("Original", scene);
		original.id = "scenario-original";
		const ground = MeshBuilder.CreateGround("Scenario Ground", { width: 20, height: 20 }, scene);
		ground.id = "scenario-ground";
		ground.material = original;
		new DirectionalLight("Scenario Sun", new Vector3(0, -1, 0), scene);
		const baked = (await bakeBakedGlobalIllumination(scene, { meshIds: [ground.id], resolution: 16, samples: 1, bounces: 0, shadowing: false }, options)) as any;
		const scenario = createLightingScenario(scene, { name: "Retained Day" }, options) as any;
		expect(scenario.bakedLighting.evidence).toMatchObject({ lightmapMeshCount: 1, probeVolumeCount: 0 });
		expect(listLightingScenarios(scene).scenarios[0]).toMatchObject({ id: scenario.id, revision: 1, bakedLighting: { sourceBakeId: baked.bakeId } });

		const cleared = (await clearBakedGlobalIllumination(scene, { expectedBakeId: baked.bakeId, confirm: true }, options)) as any;
		expect(cleared).toMatchObject({ retainedByScenarioIds: [scenario.id], deletedOutputDirectory: null, retainedOutputDirectory: baked.outputDirectory });
		expect(await pathExists(join(directory, baked.outputDirectory))).toBe(true);
		expect(scene.materials.some((material) => material.id === baked.meshEntries[0].bakedMaterialId)).toBe(true);

		const deleted = (await deleteLightingScenario(scene, { id: scenario.id, expectedRevision: scenario.revision, confirm: true }, options)) as any;
		expect(deleted).toMatchObject({ deleted: true, released: { released: true, deletedOutputDirectory: baked.outputDirectory } });
		expect(await pathExists(join(directory, baked.outputDirectory))).toBe(false);
		expect(scene.materials.some((material) => material.id === baked.meshEntries[0].bakedMaterialId)).toBe(false);
	});

	test("prefers UV2, traces deterministic bounce rays, clones shared materials per mesh, and restores from a persisted snapshot", async () => {
		const shared = new StandardMaterial("Shared", scene);
		shared.id = "shared-material";
		const first = MeshBuilder.CreateGround("First", { width: 40, height: 40 }, scene);
		first.id = "first";
		first.material = shared;
		const second = MeshBuilder.CreateGround("Second", { width: 40, height: 40 }, scene);
		second.id = "second";
		second.position.x = 60;
		second.material = shared;
		for (const mesh of [first, second]) {
			mesh.setVerticesData(VertexBuffer.UV2Kind, Array.from(mesh.getVerticesData(VertexBuffer.UVKind)!));
		}
		new DirectionalLight("Sun", new Vector3(0, -1, 0), scene);

		const baked = (await bakeBakedGlobalIllumination(
			scene,
			{ meshIds: [first.id, second.id], resolution: 16, samples: 2, bounces: 1, shadowing: false, indirectIntensity: 0.25 },
			options
		)) as any;

		expect(baked.meshEntries).toHaveLength(2);
		expect(baked.meshEntries.every((entry: any) => entry.uvSource === "uv2" && entry.coordinatesIndex === 1)).toBe(true);
		expect(new Set(baked.meshEntries.map((entry: any) => entry.bakedMaterialId)).size).toBe(2);
		expect(first.material).not.toBe(second.material);
		expect(baked.totalRayCount).toBeGreaterThan(0);

		shared.dispose(false, false);
		expect(scene.materials.some((material) => material.id === shared.id)).toBe(false);
		await clearBakedGlobalIllumination(scene, { expectedBakeId: baked.bakeId, confirm: true }, options);
		expect(first.material?.id).toBe("shared-material");
		expect(second.material).toBe(first.material);
		expect(first.material?.getClassName()).toBe("StandardMaterial");
	});

	test("preserves MultiMaterial topology while applying and clearing one per-mesh lightmap", async () => {
		const red = new PBRMaterial("Red", scene);
		red.id = "red";
		const blue = new StandardMaterial("Blue", scene);
		blue.id = "blue";
		const multi = new MultiMaterial("Multi", scene);
		multi.id = "multi";
		multi.subMaterials = [red, blue];
		const box = MeshBuilder.CreateBox("Box", { size: 20 }, scene);
		box.id = "box";
		box.material = multi;
		new DirectionalLight("Sun", new Vector3(-0.5, -1, -0.25), scene);

		const baked = (await bakeBakedGlobalIllumination(scene, { meshIds: [box.id], resolution: 16, samples: 1, bounces: 0, shadowing: false }, options)) as any;
		expect(box.material).toBeInstanceOf(MultiMaterial);
		expect((box.material as MultiMaterial).subMaterials).toHaveLength(2);
		expect(baked.meshEntries[0].bakedSubMaterialIds).toHaveLength(2);
		expect((box.material as MultiMaterial).subMaterials.every((material) => (material as PBRMaterial | StandardMaterial).lightmapTexture !== null)).toBe(true);

		await clearBakedGlobalIllumination(scene, { expectedBakeId: baked.bakeId, confirm: true }, options);
		expect(box.material).toBe(multi);
		expect(multi.subMaterials[0]).toBe(red);
		expect(multi.subMaterials[1]).toBe(blue);
	});

	test("rejects invalid geometry and leaves scene, metadata, and generated files untouched", async () => {
		const material = new PBRMaterial("No UV Material", scene);
		const mesh = new Mesh("No UV", scene);
		mesh.id = "no-uv";
		mesh.material = material;
		mesh.setVerticesData(VertexBuffer.PositionKind, [0, 0, 0, 1, 0, 0, 0, 0, 1]);
		mesh.setIndices([0, 1, 2]);

		await expect(bakeBakedGlobalIllumination(scene, { meshIds: [mesh.id], resolution: 16 }, options)).rejects.toThrow("no valid UV0 coordinates");
		expect(mesh.material).toBe(material);
		expect(getBakedGlobalIllumination(scene)).toEqual({ configured: false, backend: "bounded-cpu-one-bounce-v1" });
		expect(await pathExists(join(directory, "assets/Lighting/BakedGI"))).toBe(false);
		expect(options.editor.layout.assets.refresh).not.toHaveBeenCalled();
	});

	test("rejects generated-output symlink traversal before writing or assigning materials", async () => {
		const material = new PBRMaterial("Protected", scene);
		const ground = MeshBuilder.CreateGround("Protected Ground", { width: 20, height: 20 }, scene);
		ground.material = material;
		await mkdir(join(directory, "actual-output"));
		await symlink("actual-output", join(directory, "assets-link"), "dir");

		await expect(bakeBakedGlobalIllumination(scene, { meshIds: [ground.id], resolution: 16, bounces: 0, outputDirectory: "assets-link/BakedGI" }, options)).rejects.toThrow(
			"must not traverse symbolic links"
		);
		expect(ground.material).toBe(material);
		expect(getBakedGlobalIllumination(scene)).toEqual({ configured: false, backend: "bounded-cpu-one-bounce-v1" });
		expect((await stat(join(directory, "actual-output"))).isDirectory()).toBe(true);
		expect(options.editor.layout.assets.refresh).not.toHaveBeenCalled();
	});
});

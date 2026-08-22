import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { access, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { Texture as CoreTexture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, CreateBox, NullEngine, PBRMaterial, PointLight, Scene, Vector3 } from "babylonjs";

import {
	clearSubsurfaceMaterial,
	clearSubsurfaceRuntimeState,
	createDiffusionProfile,
	deleteDiffusionProfile,
	getDiffusionProfile,
	getSubsurfaceMaterial,
	getSubsurfaceRuntimeState,
	listDiffusionProfiles,
	setDiffusionProfile,
	setSubsurfaceMaterial,
	setSubsurfaceRuntimeState,
	refreshSubsurfaceProfileAssignments,
} from "../../src/mcp/materials/subsurface";
import { bakeSubsurfaceTransport, clearSubsurfaceTransport, getSubsurfaceTransport } from "../../src/mcp/materials/subsurface-transport";
import { getProjectAssetsRootUrl, projectConfiguration } from "../../src/project/configuration";
import { getAssetTypeFromPath } from "../../src/mcp/assets/registry";

function installSubsurfacePrePass(scene: Scene): void {
	const configuration = {
		enabled: false,
		metersPerUnit: 1,
		ssDiffusionS: [] as number[],
		ssDiffusionD: [] as number[],
		ssFilterRadii: [] as number[],
		ssDiffusionProfileColors: [] as any[],
		clearAllDiffusionProfiles(): void {
			this.ssDiffusionS.length = 0;
			this.ssDiffusionD.length = 0;
			this.ssFilterRadii.length = 0;
			this.ssDiffusionProfileColors.length = 0;
		},
		getDiffusionProfileParameters(color: { r: number; g: number; b: number }): number {
			return Math.max(color.r, color.g, color.b) * 4;
		},
		postProcess: { isReady: () => true, updateEffect: () => undefined, onApplyObservable: { add: () => null, remove: () => true } },
	};
	(scene as any)._prePassRenderer = {};
	(scene as any)._subSurfaceConfiguration = configuration;
	(scene as any).enableSubSurfaceForPrePass = () => configuration;
}

describe("mcp/subsurface-scattering", () => {
	let engine: NullEngine;
	let scene: Scene;
	let material: PBRMaterial;
	let directory: string;
	let previousPath: string | null;
	let options: any;

	beforeEach(async () => {
		engine = new NullEngine();
		scene = new Scene(engine);
		installSubsurfacePrePass(scene);
		material = new PBRMaterial("MCP Skin", scene);
		directory = await mkdtemp(join(tmpdir(), "babylon-subsurface-"));
		previousPath = projectConfiguration.path;
		projectConfiguration.path = join(directory, "Game.bjseditor");
		await writeFile(projectConfiguration.path, "{}");
		options = { editor: { layout: { inspector: { forceUpdate: vi.fn(), setEditedObject: vi.fn() }, assets: { refresh: vi.fn() } } } };
	});

	afterEach(async () => {
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = previousPath;
		await rm(directory, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	test("creates, lists, exact-updates, assigns, executes, clears, and deletes a diffusion profile", async () => {
		const baselineTextureCount = scene.textures.length;
		const path = "assets/materials/Skin.diffusionprofile.json";
		const created = await createDiffusionProfile(
			scene,
			{
				path,
				name: "Skin",
				scatteringDistance: [1.2, 0.45, 0.22],
				transmissionTint: [1, 0.3, 0.2],
				thicknessRemap: [0.25, 6],
				worldScale: 1,
				indexOfRefraction: 1.42,
			},
			options
		);
		const maskPath = "assets/materials/SkinMask.png";
		await writeFile(
			join(directory, maskPath),
			Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR42mP4z8DwH4QZGBgYGJAAAE0ABfznnqUAAAAASUVORK5CYII=", "base64")
		);
		expect(created).toMatchObject({ path, name: "Skin", assetRevision: 1, scatteringDistance: [1.2, 0.45, 0.22] });
		expect(created.contentRevision).toMatch(/^[0-9a-f]{64}$/);
		expect((await listDiffusionProfiles(scene, { search: "skin" })).profiles).toEqual([expect.objectContaining({ path, name: "Skin" })]);

		const assigned = await setSubsurfaceMaterial(
			scene,
			{
				materialId: material.id,
				expectedRevision: 0,
				profilePath: path,
				expectedProfileRevision: created.contentRevision,
				mode: "subsurface-scattering",
				subsurfaceMask: 0.8,
				subsurfaceMaskTexturePath: maskPath,
				transmissionEnabled: true,
				transmissionIntensity: 0.7,
				thicknessMultiplier: 2,
			},
			options
		);
		expect(assigned).toMatchObject({
			configured: true,
			metadata: {
				revision: 1,
				mode: "subsurface-scattering",
				subsurfaceMask: 0.8,
				subsurfaceMaskTextureAssigned: true,
				subsurfaceMaskTexturePath: maskPath,
				profile: { path, contentRevision: created.contentRevision },
			},
			native: { scatteringEnabled: true, transmissionEnabled: true, minimumThickness: 0.5, maximumThickness: 12 },
			runtime: { configured: true, profileCount: 1, materialCount: 1, profileCapacity: 15, maskTargetAllocated: true, maskTextureCount: 1 },
		});
		expect(getSubsurfaceMaterial(scene, { materialId: material.id })).toMatchObject({
			metadata: { revision: 1 },
			runtime: { backend: "babylon-native-burley-screen-space-mask-v3" },
		});
		await expect(setSubsurfaceMaterial(scene, { materialId: material.id, expectedRevision: 0, subsurfaceMask: 0.5 }, options)).rejects.toThrow("revision is stale");
		await expect(deleteDiffusionProfile(scene, { path, expectedRevision: created.contentRevision, confirm: true }, options)).rejects.toThrow("still referenced");

		const read = await getDiffusionProfile(scene, { path });
		const updated = await setDiffusionProfile(scene, { path, expectedRevision: read.contentRevision, scatteringDistance: [2, 0.6, 0.3], worldScale: 1.5 }, options);
		expect(updated).toMatchObject({ assetRevision: 2, scatteringDistance: [2, 0.6, 0.3], worldScale: 1.5, runtime: { configured: true } });
		expect(getSubsurfaceMaterial(scene, { materialId: material.id })).toMatchObject({
			metadata: { revision: 2, profile: { revision: 2, contentRevision: updated.contentRevision } },
		});
		await expect(refreshSubsurfaceProfileAssignments(scene, { path, expectedRevision: created.contentRevision }, options)).rejects.toThrow("revision is stale");
		expect(await refreshSubsurfaceProfileAssignments(scene, { path, expectedRevision: updated.contentRevision }, options)).toMatchObject({ refreshed: 0 });

		const cleared = clearSubsurfaceMaterial(scene, { materialId: material.id, expectedRevision: 2, confirm: true }, options);
		expect(cleared).toMatchObject({ cleared: true, runtime: { configured: false, materialCount: 0 } });
		expect(scene.textures).toHaveLength(baselineTextureCount);
		expect(await deleteDiffusionProfile(scene, { path, expectedRevision: updated.contentRevision, confirm: true }, options)).toMatchObject({
			deleted: true,
			path,
			name: "Skin",
		});
		expect((await listDiffusionProfiles(scene, {})).profiles).toEqual([]);
		await expect(access(join(directory, `${path}.bjsmeta.json`))).rejects.toThrow();
	});

	test("exact-revisions native quality settings and rejects traversal or malformed profile data", async () => {
		expect(getAssetTypeFromPath("assets/Skin.diffusionprofile.json")).toBe("diffusion-profile");
		const initial = getSubsurfaceRuntimeState(scene);
		expect(initial).toMatchObject({ hasExplicitSettings: false, settings: { revision: 1, enabled: true, quality: "high", sampleBudget: 64, metersPerUnit: 0.01 } });
		expect(scene.metadata?.babylonEditorSubsurfaceRuntimeSettings).toBeUndefined();
		const changed = setSubsurfaceRuntimeState(scene, { expectedRevision: 1, quality: "custom", sampleBudget: 96, metersPerUnit: 0.02 }, options);
		expect(changed).toMatchObject({ settings: { revision: 2, quality: "custom", sampleBudget: 96, metersPerUnit: 0.02 } });
		expect(() => setSubsurfaceRuntimeState(scene, { expectedRevision: 1, quality: "low" }, options)).toThrow("revision is stale");
		expect(() => clearSubsurfaceRuntimeState(scene, { expectedRevision: 1, confirm: true }, options)).toThrow("revision is stale");
		expect(clearSubsurfaceRuntimeState(scene, { expectedRevision: 2, confirm: true }, options)).toMatchObject({
			cleared: true,
			hasExplicitSettings: false,
			settings: { revision: 1, quality: "high", sampleBudget: 64, metersPerUnit: 0.01 },
		});
		expect(scene.metadata?.babylonEditorSubsurfaceRuntimeSettings).toBeUndefined();
		await expect(createDiffusionProfile(scene, { path: "../Escape.diffusionprofile.json", name: "Escape" }, options)).rejects.toThrow("stay inside");
		await writeFile(
			join(directory, "Bad.diffusionprofile.json"),
			JSON.stringify({ version: 1, type: "babylon-editor-diffusion-profile", id: "bad", name: "Bad", revision: 1, unknown: true })
		);
		await expect(getDiffusionProfile(scene, { path: "Bad.diffusionprofile.json" })).rejects.toThrow("unknown fields");
	});

	test("bakes, signs, activates, exact-rejects, and transactionally clears camera-independent off-screen transport", async () => {
		const mesh = CreateBox("MCP Transport Mesh", { size: 100 }, scene);
		mesh.id = "mcp-transport-mesh";
		mesh.material = material;
		const light = new PointLight("Back Light", new Vector3(0, 0, 175), scene);
		light.diffuse = new Color3(1, 0.3, 0.15);
		light.intensity = 5;
		light.range = 500;
		const profilePath = "assets/materials/Transport.diffusionprofile.json";
		const profile = await createDiffusionProfile(
			scene,
			{
				path: profilePath,
				name: "Transport Skin",
				scatteringDistance: [1000, 1000, 1000],
				transmissionTint: [1, 0.5, 0.25],
				thicknessRemap: [0, 200],
			},
			options
		);
		await setSubsurfaceMaterial(
			scene,
			{
				materialId: material.id,
				expectedRevision: 0,
				profilePath,
				expectedProfileRevision: profile.contentRevision,
				transmissionEnabled: true,
				transmissionIntensity: 2,
			},
			options
		);
		setSubsurfaceRuntimeState(scene, { expectedRevision: 1, transportMode: "baked-ray-traced", transportIntensity: 1.25 }, options);
		mesh.scaling.z = 0;
		await expect(bakeSubsurfaceTransport(scene, { materialId: material.id, meshId: mesh.id, expectedRevision: 1, resolution: 16, sampleCount: 1 }, options)).rejects.toThrow(
			"non-invertible world transform"
		);
		mesh.scaling.z = 1;

		const baked = await bakeSubsurfaceTransport(
			scene,
			{
				materialId: material.id,
				meshId: mesh.id,
				expectedRevision: 1,
				resolution: 16,
				sampleCount: 1,
				maxDistance: 250,
				bias: 0.01,
				shadowing: false,
				dilation: 1,
				uvChannel: "uv0",
			},
			options
		);
		expect(baked).toMatchObject({
			materialId: material.id,
			materialRevision: 2,
			cache: {
				meshId: mesh.id,
				revision: 1,
				resolution: 16,
				sampleCount: 1,
				backend: "bounded-cpu-ray-traced-offscreen-transport-v1",
				ownership: "editor-generated",
				coveredTexels: expect.any(Number),
				hitTexels: expect.any(Number),
				rayCount: expect.any(Number),
			},
			runtime: { enabled: true, cacheCount: 1, activeCacheCount: 1, staleCacheCount: 0 },
		});
		expect(baked.cache.coveredTexels).toBeGreaterThan(0);
		expect(baked.cache.hitTexels).toBeGreaterThan(0);
		expect(baked.cache.rayCount).toBeGreaterThanOrEqual(baked.cache.coveredTexels);
		expect(baked.cache.contentRevision).toMatch(/^[0-9a-f]{64}$/);
		await expect(access(join(directory, baked.cache.texturePath))).resolves.toBeUndefined();
		expect(getSubsurfaceTransport(scene, { materialId: material.id })).toMatchObject({
			materialRevision: 2,
			settingsRevision: 2,
			caches: [expect.objectContaining({ meshId: mesh.id, revision: 1 })],
		});
		mesh.position.x = 1;
		expect(getSubsurfaceTransport(scene, { materialId: material.id })).toMatchObject({
			runtime: { activeCacheCount: 0, staleCacheCount: 1, caches: [expect.objectContaining({ meshId: mesh.id, stale: true, active: false })] },
		});
		const parseTexture = vi.spyOn(CoreTexture, "Parse");
		mesh.position.x = 0;
		const reactivated = getSubsurfaceTransport(scene, { materialId: material.id });
		expect(reactivated).toMatchObject({
			runtime: { activeCacheCount: 1, staleCacheCount: 0, caches: [expect.objectContaining({ meshId: mesh.id, stale: false, active: true })] },
		});
		expect(parseTexture).toHaveBeenCalledWith(expect.any(Object), scene, getProjectAssetsRootUrl());
		parseTexture.mockRestore();
		await expect(bakeSubsurfaceTransport(scene, { materialId: material.id, meshId: mesh.id, expectedRevision: 1, expectedCacheRevision: 1 }, options)).rejects.toThrow(
			"revision is stale"
		);

		const cleared = await clearSubsurfaceTransport(scene, { materialId: material.id, meshId: mesh.id, expectedRevision: 2, expectedCacheRevision: 1, confirm: true }, options);
		expect(cleared).toMatchObject({ cleared: true, materialRevision: 3, meshId: mesh.id, runtime: { enabled: true, cacheCount: 0 } });
		await expect(access(join(directory, baked.cache.texturePath))).rejects.toThrow();
		expect(getSubsurfaceTransport(scene, { materialId: material.id })).toMatchObject({ materialRevision: 3, caches: [] });
	});

	test("rolls profile files and material snapshots back when native activation fails", async () => {
		const path = "assets/materials/Rollback.diffusionprofile.json";
		const created = await createDiffusionProfile(scene, { path, name: "Rollback" }, options);
		await setSubsurfaceMaterial(scene, { materialId: material.id, expectedRevision: 0, profilePath: path, expectedProfileRevision: created.contentRevision }, options);
		const beforeFile = await getDiffusionProfile(scene, { path });
		const beforeMaterial = getSubsurfaceMaterial(scene, { materialId: material.id });
		const configuration = scene.subSurfaceConfiguration!;
		let attempts = 0;
		(scene as any).enableSubSurfaceForPrePass = () => (++attempts === 1 ? null : configuration);
		(scene as any)._subSurfaceConfiguration = null;

		await expect(setDiffusionProfile(scene, { path, expectedRevision: beforeFile.contentRevision, scatteringDistance: [4, 2, 1] }, options)).rejects.toThrow(
			"could not be activated"
		);
		const afterFile = await getDiffusionProfile(scene, { path });
		const afterMaterial = getSubsurfaceMaterial(scene, { materialId: material.id });
		expect(afterFile).toMatchObject({
			assetRevision: beforeFile.assetRevision,
			contentRevision: beforeFile.contentRevision,
			scatteringDistance: beforeFile.scatteringDistance,
		});
		expect(afterMaterial.metadata).toEqual(beforeMaterial.metadata);
	});
});

import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path/posix";

import { Color3, HemisphericLight, MeshBuilder, NullEngine, PBRMaterial, PointLight, Scene, StandardMaterial, Vector3 } from "babylonjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getEditorCapabilities } from "../../src/mcp/editor";
import {
	deleteLightingSearchQuery,
	getLightingSearchLightmapPreview,
	inspectLightingSearch,
	queryLightingSearch,
	saveLightingSearchQuery,
	setLightingSearchProperties,
} from "../../src/mcp/lights/lighting-search";
import { MCPEndpoints } from "../../src/mcp/mcp";
import { projectConfiguration } from "../../src/project/configuration";
import { clearUndoRedo, redo, undo } from "../../src/tools/undoredo";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAFAgIACQsC/QAAAABJRU5ErkJggg==", "base64");

describe("mcp/lighting-search", () => {
	let directory: string;
	let engine: NullEngine;
	let scene: Scene;
	let options: any;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "babylon-lighting-search-"));
		projectConfiguration.path = join(directory, "project.bjseditor");
		engine = new NullEngine();
		scene = new Scene(engine);
		options = {
			editor: {
				state: { projectPath: projectConfiguration.path, enableExperimentalFeatures: false },
				layout: {
					preview: { clusteredLightContainer: { lights: [] } },
					lightingSearch: { refresh: vi.fn() },
					graph: { refresh: vi.fn().mockResolvedValue(undefined) },
					inspector: { forceUpdate: vi.fn() },
					selectTab: vi.fn(),
				},
			},
		};
		clearUndoRedo();
	});

	afterEach(async () => {
		clearUndoRedo();
		scene.dispose();
		engine.dispose();
		projectConfiguration.path = null;
		await rm(directory, { recursive: true, force: true });
	});

	test("publishes an immutable built-in query tree and exact custom-query lifecycle", () => {
		const initial = inspectLightingSearch(scene) as any;
		expect(initial).toMatchObject({
			backend: "bounded-babylon-lighting-search-v1",
			state: { version: 1, revision: 1 },
			providers: expect.arrayContaining(["lights", "lightmaps", "lighting-settings"]),
		});
		expect(initial.queryTree.find((entry: any) => entry.id === "lightmaps-all")).toMatchObject({ builtIn: true, provider: "lightmaps", pipeline: "baked-gi" });

		const created = saveLightingSearchQuery(
			scene,
			{
				expectedRevision: initial.state.revision,
				expectedFingerprint: initial.fingerprint,
				query: {
					name: "Bright lights",
					parentId: "lights",
					provider: "lights",
					pipeline: "portable-deferred",
					filters: [{ field: "intensity", operator: "gte", value: 2 }],
					columns: ["name", "intensity"],
				},
			},
			options
		) as any;
		expect(created).toMatchObject({ created: true, query: { name: "Bright lights", revision: 1 }, state: { revision: 2 } });
		expect(() =>
			saveLightingSearchQuery(scene, { expectedRevision: 1, expectedFingerprint: initial.fingerprint, query: { name: "Stale", provider: "lights" } }, options)
		).toThrow("query tree changed");
		undo();
		expect((inspectLightingSearch(scene) as any).state.customQueries).toHaveLength(0);
		redo();
		const current = inspectLightingSearch(scene) as any;
		expect(current.state.customQueries).toHaveLength(1);
		const deleted = deleteLightingSearchQuery(
			scene,
			{ expectedRevision: current.state.revision, expectedFingerprint: current.fingerprint, id: created.query.id, expectedQueryRevision: 1, confirm: true },
			options
		) as any;
		expect(deleted).toMatchObject({ deleted: true, state: { revision: 3 } });
		expect(() =>
			deleteLightingSearchQuery(
				scene,
				{ expectedRevision: deleted.state.revision, expectedFingerprint: deleted.fingerprint, id: "lights-all", expectedQueryRevision: 1, confirm: true },
				options
			)
		).toThrow("immutable");
	});

	test("queries providers with pipeline selection, structured filtering, sorting, and pagination", () => {
		const key = new PointLight("Key", new Vector3(0, 100, 0), scene);
		key.id = "key";
		key.intensity = 3;
		const fill = new HemisphericLight("Fill", Vector3.Up(), scene);
		fill.id = "fill";
		fill.intensity = 0.5;
		const clustered = new PointLight("Clustered", Vector3.Zero(), scene);
		clustered.id = "clustered";
		scene.removeLight(clustered);
		options.editor.layout.preview.clusteredLightContainer.lights.push(clustered);

		const bright = queryLightingSearch(
			scene,
			{
				provider: "lights",
				pipeline: "portable-deferred",
				filters: [{ field: "intensity", operator: "gte", value: 2 }],
				sortField: "intensity",
				sortDirection: "desc",
				offset: 0,
				limit: 1,
			},
			options
		) as any;
		expect(bright).toMatchObject({ total: 1, count: 1, items: [{ id: "key", properties: { intensity: 3 } }] });
		const clusteredOnly = queryLightingSearch(scene, { queryId: "lights-clustered", limit: 10 }, options) as any;
		expect(clusteredOnly.items).toEqual([expect.objectContaining({ id: "clustered", pipelines: expect.arrayContaining(["clustered-forward"]) })]);
		expect(() => queryLightingSearch(scene, { provider: "lights", queryId: "lights-all" }, options)).toThrow();
	});

	test("batch-edits exact rows atomically and rolls back earlier operations on a later failure", () => {
		const light = new PointLight("Lamp", Vector3.Zero(), scene);
		light.id = "lamp";
		light.intensity = 1;
		const mesh = MeshBuilder.CreateBox("Wall", {}, scene);
		mesh.id = "wall";
		const material = new PBRMaterial("Wall Material", scene);
		material.id = "wall-material";
		mesh.material = material;

		const lightRow = (queryLightingSearch(scene, { provider: "lights" }, options) as any).items[0];
		const meshRow = (queryLightingSearch(scene, { provider: "mesh-renderers" }, options) as any).items[0];
		const updated = setLightingSearchProperties(
			scene,
			{
				operations: [
					{ provider: "lights", id: lightRow.id, expectedFingerprint: lightRow.fingerprint, properties: { intensity: 4, diffuse: [1, 0.5, 0.25] } },
					{ provider: "mesh-renderers", id: meshRow.id, expectedFingerprint: meshRow.fingerprint, properties: { visibility: 0.5, receiveShadows: true } },
				],
			},
			options
		) as any;
		expect(updated.updated).toBe(2);
		expect(light.intensity).toBe(4);
		expect(light.diffuse.asArray()).toEqual([1, 0.5, 0.25]);
		expect(mesh.visibility).toBe(0.5);
		undo();
		expect(light.intensity).toBe(1);
		expect(mesh.visibility).toBe(1);
		redo();
		expect(light.intensity).toBe(4);

		const refreshedLight = (queryLightingSearch(scene, { provider: "lights" }, options) as any).items[0];
		const refreshedMesh = (queryLightingSearch(scene, { provider: "mesh-renderers" }, options) as any).items[0];
		expect(() =>
			setLightingSearchProperties(
				scene,
				{
					operations: [
						{ provider: "lights", id: refreshedLight.id, expectedFingerprint: refreshedLight.fingerprint, properties: { intensity: 9 } },
						{ provider: "mesh-renderers", id: refreshedMesh.id, expectedFingerprint: refreshedMesh.fingerprint, properties: { unsupported: true } },
					],
				},
				options
			)
		).toThrow("every prior change was rolled back");
		expect(light.intensity).toBe(4);
		expect(() =>
			setLightingSearchProperties(
				scene,
				{ operations: [{ provider: "lights", id: light.id, expectedFingerprint: lightRow.fingerprint, properties: { intensity: 5 } }] },
				options
			)
		).toThrow("changed");
	});

	test("browses generated lightmaps and opens an exact project-contained exposure preview", async () => {
		const mesh = MeshBuilder.CreateGround("Floor", {}, scene);
		mesh.id = "floor";
		mesh.material = new StandardMaterial("Floor Baked", scene);
		const lightmapPath = "assets/Lighting/BakedGI/test/floor.png";
		await mkdir(dirname(join(directory, lightmapPath)), { recursive: true });
		await writeFile(join(directory, lightmapPath), png);
		scene.metadata = {
			babylonEditorBakedGi: {
				version: 1,
				backend: "bounded-cpu-one-bounce-v1",
				bakeId: "bake-1",
				createdAt: new Date(0).toISOString(),
				outputDirectory: "assets/Lighting/BakedGI/test",
				resolution: 64,
				samples: 1,
				bounces: 0,
				directIntensity: 1,
				indirectIntensity: 0,
				shadowing: false,
				shadowBias: 0.05,
				maxDistance: 1000,
				dilation: 1,
				encoding: "linear-rgba8-clamped",
				limitations: [],
				meshEntries: [
					{
						meshId: mesh.id,
						meshName: mesh.name,
						originalMaterialId: null,
						originalMaterial: { kind: "none" },
						bakedMaterialId: mesh.material.id,
						bakedSubMaterialIds: [mesh.material.id],
						lightmapPath,
						coordinatesIndex: 1,
						uvSource: "uv2",
						coveredTexels: 2048,
						overlapTexels: 7,
						saturatedTexels: 2,
						rayCount: 2048,
					},
				],
			},
		};
		const query = queryLightingSearch(scene, { queryId: "lightmaps-all", limit: 10 }, options) as any;
		expect(query.items[0]).toMatchObject({ id: "lightmap:floor", properties: { width: 64, height: 64, format: "png", overlapTexels: 7, coveragePercent: 50 } });
		const preview = (await getLightingSearchLightmapPreview(scene, { id: query.items[0].id, expectedFingerprint: query.items[0].fingerprint, exposureEV: 2 }, options)) as any;
		expect(preview).toMatchObject({ projectRelativePath: lightmapPath, mimeType: "image/png", bytes: png.length, exposureEV: 2, exposureMultiplier: 4 });
		expect(preview.previewUrl).toMatch(/^file:/);
		expect(preview.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(options.editor.layout.selectTab).toHaveBeenCalledWith("lighting-search");
		await expect(getLightingSearchLightmapPreview(scene, { id: query.items[0].id, expectedFingerprint: query.items[0].fingerprint, exposureEV: 17 }, options)).rejects.toThrow(
			"-16 through 16"
		);
	});

	test("maps all six strict endpoints and advertises the complete editor feature family", () => {
		expect(
			[
				"inspect_lighting_search",
				"save_lighting_search_query",
				"delete_lighting_search_query",
				"query_lighting_search",
				"get_lighting_search_lightmap_preview",
				"set_lighting_search_properties",
			].every((endpoint) => typeof (MCPEndpoints as any)[endpoint] === "function")
		).toBe(true);
		expect(getEditorCapabilities(scene, {}, options).features).toMatchObject({
			lightingSearchWorkspace: true,
			lightingSearchQueryTree: true,
			lightingSearchLightmapPreview: true,
			lightingSearchBatchEditing: true,
		});
	});
});

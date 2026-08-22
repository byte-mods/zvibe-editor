import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DirectionalLight, MeshBuilder, NullEngine, PBRMaterial, Scene, StandardMaterial, Vector3 } from "babylonjs";

import {
	bakeLightProbeVolume,
	createLightProbeVolume,
	deleteLightProbeVolume,
	getLightProbeRuntime,
	listLightProbeVolumes,
	setLightProbeVolume,
} from "../../src/mcp/lights/light-probes";

describe("mcp/light probes and adaptive probe volumes", () => {
	let engine: NullEngine;
	let scene: Scene;
	const options = {
		editor: { layout: { inspector: { setEditedObject: vi.fn(), forceUpdate: vi.fn() } } },
	} as any;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		vi.clearAllMocks();
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("creates, adaptively bakes, evaluates, updates, stale-protects, and deletes one complete volume lifecycle", () => {
		const target = MeshBuilder.CreateBox("Dynamic Target", { size: 10 }, scene);
		target.id = "dynamic-target";
		target.position.y = 20;
		target.material = new PBRMaterial("Target PBR", scene);
		const ground = MeshBuilder.CreateGround("Static Ground", { width: 80, height: 80 }, scene);
		ground.id = "static-ground";
		ground.material = new StandardMaterial("Ground Standard", scene);
		const sun = new DirectionalLight("Sun", new Vector3(-0.2, -1, -0.1), scene);
		sun.intensity = 1.5;

		const created = createLightProbeVolume(
			scene,
			{
				name: "Gameplay APV",
				minimum: [-50, -10, -50],
				maximum: [50, 50, 50],
				baseResolution: [2, 2, 2],
				adaptiveLevels: 1,
				targetMeshIds: [target.id],
			},
			options
		) as any;
		expect(created.volume).toMatchObject({ name: "Gameplay APV", revision: 1, bake: null, targetMeshIds: [target.id] });

		const baked = bakeLightProbeVolume(
			scene,
			{ id: created.volume.id, expectedRevision: 1, samples: 8, maxDistance: 200, shadowBias: 0.5, geometryMeshIds: [ground.id] },
			options
		) as any;
		expect(baked.volume).toMatchObject({ revision: 2, bake: { backend: "bounded-cpu-adaptive-sh9-v1", samples: 8 } });
		expect(baked.volume.bake.evidence).toMatchObject({ probeCount: 27, cellCount: 8, baseCellCount: 1, refinedCellCount: 8, geometryMeshCount: 1 });
		expect(baked.volume.bake.evidence.totalRays).toBeGreaterThanOrEqual(27 * 8);
		expect(baked.volume.bake.evidence.averageValidity).toBeGreaterThanOrEqual(0);

		const runtime = getLightProbeRuntime(scene, { meshId: target.id, position: [0, 20, 0] }) as any;
		expect(runtime).toMatchObject({ backend: "bounded-adaptive-sh9-material-plugin-v1", evaluation: { meshId: target.id, volumeIds: [created.volume.id] } });
		expect(runtime.evaluation.coefficients).toHaveLength(27);
		expect(runtime.evaluation.coefficients.every(Number.isFinite)).toBe(true);
		expect(runtime.runtime).toMatchObject({ configured: true, shaderLanguages: ["GLSL", "WGSL"], matchedQueries: 1 });

		expect(() => setLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 1, enabled: false }, options)).toThrow("changed");
		const disabled = setLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 2, enabled: false }, options) as any;
		expect(disabled).toMatchObject({ updated: true, bakeInvalidated: false, volume: { enabled: false, revision: 3 } });
		expect((disabled.volume as any).bake.bakeId).toBe(baked.volume.bake.bakeId);

		const relayout = setLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 3, baseResolution: [3, 3, 3] }, options) as any;
		expect(relayout).toMatchObject({ updated: true, bakeInvalidated: true, volume: { revision: 4, bake: null } });
		expect(() => deleteLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 3, confirm: true }, options)).toThrow("changed");
		expect(() => deleteLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 4 }, options)).toThrow("confirm: true");
		expect(deleteLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 4, confirm: true }, options)).toMatchObject({ deleted: true, id: created.volume.id });
		expect(listLightProbeVolumes(scene)).toMatchObject({ total: 0, volumes: [], runtime: { volumeCount: 0 } });
	});

	test("keeps metadata atomic when explicit geometry is missing or adaptive bounds are exceeded", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 5 }, scene);
		target.id = "target";
		target.material = new PBRMaterial("Target Material", scene);
		const huge = MeshBuilder.CreateBox("Huge Static", { size: 1000 }, scene);
		huge.id = "huge";
		huge.material = new StandardMaterial("Static Material", scene);
		const created = createLightProbeVolume(
			scene,
			{ name: "Bounded", minimum: [-100, -100, -100], maximum: [100, 100, 100], baseResolution: [8, 8, 8], adaptiveLevels: 2, targetMeshIds: [target.id] },
			options
		) as any;

		expect(() => bakeLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 1, samples: 8, geometryMeshIds: ["missing"] }, options)).toThrow("not found");
		expect((listLightProbeVolumes(scene, { id: created.volume.id }) as any).volumes[0]).toMatchObject({ revision: 1, bake: null });
		expect(() => bakeLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 1, samples: 8, geometryMeshIds: [huge.id] }, options)).toThrow(
			"Adaptive subdivision would exceed"
		);
		expect((listLightProbeVolumes(scene, { id: created.volume.id }) as any).volumes[0]).toMatchObject({ revision: 1, bake: null });
		expect(options.editor.layout.inspector.forceUpdate).toHaveBeenCalledTimes(1);
	});

	test("pages exact baked coefficients and cells without returning the complete bounded payload by default", () => {
		const target = MeshBuilder.CreateBox("Target", { size: 5 }, scene);
		target.id = "target";
		target.material = new PBRMaterial("Target Material", scene);
		const created = createLightProbeVolume(
			scene,
			{ name: "Paged", minimum: [-10, -10, -10], maximum: [10, 10, 10], baseResolution: [2, 2, 2], adaptiveLevels: 0, targetMeshIds: [target.id] },
			options
		) as any;
		const baked = bakeLightProbeVolume(scene, { id: created.volume.id, expectedRevision: 1, samples: 8, geometryMeshIds: [] }, options) as any;

		const summary = listLightProbeVolumes(scene, { id: created.volume.id }) as any;
		expect(summary.volumes[0].bake.probes).toBeUndefined();
		const page = listLightProbeVolumes(scene, { id: created.volume.id, includeBakeData: true, probeLimit: 2, cellLimit: 1 }) as any;
		expect(page.bakeData).toMatchObject({ probeTotal: 8, probeOffset: 0, probeHasMore: true, cellTotal: 1, cellHasMore: false });
		expect(page.bakeData.probes).toHaveLength(2);
		expect(page.bakeData.probes[0].coefficients).toHaveLength(27);
		expect(page.volumes[0].bake.bakeId).toBe(baked.volume.bake.bakeId);
	});
});

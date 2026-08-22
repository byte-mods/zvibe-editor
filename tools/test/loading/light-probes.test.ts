import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

import { configureLightProbeVolumes, getLightProbeRuntimeEvidence, ILightProbeVolume, validateLightProbeVolumes } from "../../src/loading/light-probes";

function probe(position: [number, number, number], l00: number) {
	return { position, coefficients: [l00, l00 * 2, l00 * 3, ...new Array(24).fill(0)], validity: 1, rays: 8 };
}

function volume(id: string, meshId: string, priority = 0, valueScale = 1): ILightProbeVolume {
	return {
		version: 1,
		id,
		name: id,
		revision: 1,
		enabled: true,
		priority,
		minimum: [0, 0, 0],
		maximum: [10, 10, 10],
		baseResolution: [2, 2, 2],
		adaptiveLevels: 0,
		blendDistance: 5,
		targetMeshIds: [meshId],
		bake: {
			bakeId: `${id}-bake`,
			backend: "bounded-cpu-adaptive-sh9-v1",
			bakedAt: "2026-07-28T00:00:00.000Z",
			samples: 8,
			maxDistance: 100,
			shadowBias: 1,
			environmentIntensity: 1,
			directIntensity: 1,
			bounceIntensity: 1,
			probes: [
				probe([0, 0, 0], 0 * valueScale),
				probe([10, 0, 0], 1 * valueScale),
				probe([0, 10, 0], 2 * valueScale),
				probe([10, 10, 0], 3 * valueScale),
				probe([0, 0, 10], 4 * valueScale),
				probe([10, 0, 10], 5 * valueScale),
				probe([0, 10, 10], 6 * valueScale),
				probe([10, 10, 10], 7 * valueScale),
			],
			cells: [{ minimum: [0, 0, 0], maximum: [10, 10, 10], probeIndices: [0, 1, 2, 3, 4, 5, 6, 7], level: 0 }],
			evidence: {
				probeCount: 8,
				cellCount: 1,
				baseCellCount: 1,
				refinedCellCount: 0,
				totalRays: 64,
				minimumValidity: 1,
				averageValidity: 1,
				maximumCoefficient: 21 * valueScale,
				geometryMeshCount: 0,
			},
		},
	};
}

describe("loading/light-probes", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("trilinearly interpolates SH9 for moving targeted meshes and records exact runtime evidence", () => {
		const mesh = MeshBuilder.CreateBox("Dynamic", { size: 1 }, scene);
		mesh.id = "dynamic";
		mesh.material = new PBRMaterial("PBR", scene);
		scene.metadata = { babylonEditorLightProbeVolumes: [volume("main", mesh.id)] };

		const runtime = configureLightProbeVolumes(scene);
		const evaluation = runtime.evaluate(mesh, new Vector3(5, 5, 5));

		expect(evaluation?.coefficients.slice(0, 3)).toEqual([3.5, 7, 10.5]);
		expect(evaluation).toMatchObject({ volumeIds: ["main"], weights: [1], cellLevels: [0] });
		expect(runtime.evaluate(mesh, new Vector3(12.5, 5, 5))?.coefficients[0]).toBe(4);
		expect(runtime.evaluate(mesh, new Vector3(16, 5, 5))).toBeNull();
		expect(getLightProbeRuntimeEvidence(scene)).toMatchObject({
			configured: true,
			volumeCount: 1,
			bakedVolumeCount: 1,
			targetMeshCount: 1,
			queries: 3,
			matchedQueries: 2,
			lastMeshId: mesh.id,
		});
		expect(getLightProbeRuntimeEvidence(scene).materialPluginCount).toBeGreaterThanOrEqual(1);
	});

	test("blends overlapping volumes with deterministic priority weighting", () => {
		const mesh = MeshBuilder.CreateBox("Dynamic", { size: 1 }, scene);
		mesh.id = "dynamic";
		mesh.material = new PBRMaterial("PBR", scene);
		scene.metadata = { babylonEditorLightProbeVolumes: [volume("low", mesh.id, 0, 1), volume("high", mesh.id, 2, 2)] };

		const evaluation = configureLightProbeVolumes(scene).evaluate(mesh, new Vector3(5, 5, 5));
		expect(evaluation?.weights[0]).toBeCloseTo(0.2);
		expect(evaluation?.weights[1]).toBeCloseTo(0.8);
		expect(evaluation?.coefficients[0]).toBeCloseTo(6.3);
	});

	test("survives persisted metadata reload and exposes exact GLSL and WGSL PBR hooks", () => {
		const mesh = MeshBuilder.CreateBox("Dynamic", { size: 1 }, scene);
		mesh.id = "dynamic";
		mesh.material = new PBRMaterial("PBR", scene);
		scene.metadata = { babylonEditorLightProbeVolumes: [volume("persisted", mesh.id)] };
		const persistedMetadata = JSON.parse(JSON.stringify(scene.metadata)) as Scene["metadata"];

		const reloadedEngine = new NullEngine();
		const reloadedScene = new Scene(reloadedEngine);
		try {
			const reloadedMesh = MeshBuilder.CreateBox("Dynamic", { size: 1 }, reloadedScene);
			reloadedMesh.id = mesh.id;
			reloadedMesh.material = new PBRMaterial("PBR", reloadedScene);
			reloadedScene.metadata = persistedMetadata;

			const evaluation = configureLightProbeVolumes(reloadedScene).evaluate(reloadedMesh, new Vector3(5, 5, 5));
			expect(evaluation?.coefficients.slice(0, 3)).toEqual([3.5, 7, 10.5]);
			const plugin = reloadedMesh.material.pluginManager?.getPlugin("BabylonEditorLightProbeVolume");
			expect(plugin?.getClassName()).toBe("BabylonEditorLightProbeVolumeMaterialPlugin");
			const glsl = plugin?.getCustomCode("fragment", ShaderLanguage.GLSL);
			const wgsl = plugin?.getCustomCode("fragment", ShaderLanguage.WGSL);
			expect(glsl?.CUSTOM_FRAGMENT_DEFINITIONS).toContain("vec3 babylonEditorEvaluateProbe");
			expect(glsl?.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain("finalDiffuse += babylonEditorEvaluateProbe(normalW)");
			expect(wgsl?.CUSTOM_FRAGMENT_DEFINITIONS).toContain("fn babylonEditorEvaluateProbe");
			expect(wgsl?.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain("finalDiffuse += babylonEditorEvaluateProbe(normalW)");
		} finally {
			reloadedScene.dispose();
			reloadedEngine.dispose();
		}
	});

	test("rejects malformed coefficient, topology, target, and bound payloads", () => {
		const valid = volume("valid", "mesh");
		expect(validateLightProbeVolumes([valid])).toHaveLength(1);
		expect(() => validateLightProbeVolumes([{ ...valid, maximum: [0, 10, 10] }])).toThrow("greater than minimum");
		expect(() => validateLightProbeVolumes([{ ...valid, targetMeshIds: ["mesh", "mesh"] }])).toThrow("unique bounded mesh ids");
		expect(() =>
			validateLightProbeVolumes([
				{ ...valid, bake: { ...valid.bake!, probes: valid.bake!.probes.map((entry, index) => (index === 0 ? { ...entry, coefficients: [1] } : entry)) } },
			])
		).toThrow("exactly 27 finite numbers");
		expect(() => validateLightProbeVolumes([{ ...valid, bake: { ...valid.bake!, cells: [{ ...valid.bake!.cells[0], probeIndices: [0, 1, 2, 3, 4, 5, 6, 99] }] } }])).toThrow(
			"eight valid probe indices"
		);
	});
});

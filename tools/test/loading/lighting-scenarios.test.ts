import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { Scene } from "@babylonjs/core/scene";

import { configureLightProbeVolumes, ILightProbeVolume } from "../../src/loading/light-probes";
import { configureLightingScenarios } from "../../src/loading/lighting-scenarios";

function probeVolume(id: string, meshId: string, value: number): ILightProbeVolume {
	const positions = [
		[0, 0, 0],
		[10, 0, 0],
		[0, 10, 0],
		[10, 10, 0],
		[0, 0, 10],
		[10, 0, 10],
		[0, 10, 10],
		[10, 10, 10],
	] as [number, number, number][];
	return {
		version: 1,
		id,
		name: id,
		revision: 1,
		enabled: true,
		priority: 0,
		minimum: [0, 0, 0],
		maximum: [10, 10, 10],
		baseResolution: [2, 2, 2],
		adaptiveLevels: 0,
		blendDistance: 0,
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
			probes: positions.map((position) => ({ position, coefficients: new Array(27).fill(value), validity: 1, rays: 8 })),
			cells: [{ minimum: [0, 0, 0], maximum: [10, 10, 10], probeIndices: [0, 1, 2, 3, 4, 5, 6, 7], level: 0 }],
			evidence: {
				probeCount: 8,
				cellCount: 1,
				baseCellCount: 1,
				refinedCellCount: 0,
				totalRays: 64,
				minimumValidity: 1,
				averageValidity: 1,
				maximumCoefficient: value,
				geometryMeshCount: 0,
			},
		},
	};
}

describe("loading/lighting-scenarios", () => {
	let engine: NullEngine;
	let scene: Scene;
	let light: PointLight;

	beforeEach(() => {
		engine = new NullEngine();
		scene = new Scene(engine);
		light = new PointLight("Lamp", Vector3.Zero(), scene);
		light.intensity = 0;
		light.diffuse = new Color3(0, 0, 1);
		scene.metadata = {
			babylonEditorLightingScenarios: [
				{
					id: "night",
					name: "Night",
					lights: [{ nodeId: light.id, nodeName: light.name, enabled: true, intensity: 2, diffuse: [1, 0, 0], specular: [1, 1, 1], position: [50, 0, 0] }],
				},
			],
		};
	});

	afterEach(() => {
		vi.restoreAllMocks();
		scene.dispose();
		engine.dispose();
	});

	test("exposes persisted scenarios and applies an immediate cross-fade target", () => {
		configureLightingScenarios(scene);
		expect(scene.lightingScenarios?.blendTo("Night", 0)).toBe(true);
		expect(light.intensity).toBe(2);
		expect(light.diffuse.asArray()).toEqual([1, 0, 0]);
		expect(light.position.x).toBe(50);
	});

	test("cross-fades retained PBR lightmaps and adaptive SH9 probes before committing the target scenario", () => {
		const mesh = MeshBuilder.CreateBox("Dynamic", { size: 1 }, scene);
		mesh.id = "dynamic";
		mesh.position.copyFromFloats(5, 5, 5);
		const day = new PBRMaterial("Day", scene);
		day.id = "day-material";
		day.lightmapTexture = RawTexture.CreateRGBATexture(new Uint8Array([255, 128, 0, 255]), 1, 1, scene);
		day.lightmapTexture.coordinatesIndex = 0;
		const night = new PBRMaterial("Night", scene);
		night.id = "night-material";
		night.lightmapTexture = RawTexture.CreateRGBATexture(new Uint8Array([0, 64, 255, 255]), 1, 1, scene);
		night.lightmapTexture.coordinatesIndex = 0;
		mesh.material = day;
		const dayProbes = [probeVolume("day-probes", mesh.id, 1)];
		const nightProbes = [probeVolume("night-probes", mesh.id, 3)];
		const baked = (materialId: string, path: string, volumes: ILightProbeVolume[]) => ({
			backend: "bounded-lightmap-adaptive-sh9-scenario-v1",
			bakedGi: {
				sourceBakeId: `${materialId}-bake`,
				outputDirectory: `assets/Lighting/${materialId}`,
				meshEntries: [{ meshId: mesh.id, meshName: mesh.name, materialId, subMaterialIds: [materialId], lightmapPath: path, coordinatesIndex: 0 }],
			},
			lightProbeVolumes: volumes,
			evidence: { lightmapMeshCount: 1, probeVolumeCount: 1, probeCount: 8, cellCount: 1 },
		});
		scene.metadata = {
			babylonEditorActiveLightingScenarioId: "day",
			babylonEditorLightProbeVolumes: dayProbes,
			babylonEditorLightingScenarios: [
				{ version: 2, id: "day", name: "Day", revision: 1, lights: [], bakedLighting: baked(day.id, "day.png", dayProbes) },
				{ version: 2, id: "night", name: "Night", revision: 1, lights: [], bakedLighting: baked(night.id, "night.png", nightProbes) },
			],
		};
		configureLightProbeVolumes(scene);
		const controller = configureLightingScenarios(scene);
		const now = vi.spyOn(Date, "now");
		now.mockReturnValue(0);
		expect(controller.blendTo("Night", 100)).toBe(true);
		now.mockReturnValue(50);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(controller.inspect()).toMatchObject({ blending: true, targetScenarioId: "night", weight: 0.5, lightmapMeshCount: 1, probeVolumeCount: 1 });
		expect(scene.lightProbeVolumes?.inspect().scenarioBlend).toEqual({ active: true, weight: 0.5, targetVolumeCount: 1 });
		expect(scene.lightProbeVolumes?.evaluate(mesh, new Vector3(5, 5, 5))?.coefficients[0]).toBe(2);
		const plugin = day.pluginManager?.getPlugin("BabylonEditorBakedLightingScenario");
		expect(plugin?.getClassName()).toBe("BabylonEditorBakedLightingScenarioMaterialPlugin");
		const glslCode = plugin?.getCustomCode("fragment", ShaderLanguage.GLSL);
		expect(glslCode?.CUSTOM_FRAGMENT_DEFINITIONS).toContain("uniform sampler2D babylonEditorScenarioLightmapSampler");
		expect(glslCode?.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain("lightmapColor = mix");
		const wgslCode = plugin?.getCustomCode("fragment", ShaderLanguage.WGSL);
		expect(wgslCode?.CUSTOM_FRAGMENT_DEFINITIONS).toContain("var babylonEditorScenarioLightmapSampler: texture_2d<f32>");
		expect(wgslCode?.CUSTOM_FRAGMENT_DEFINITIONS).toContain("var babylonEditorScenarioLightmapSamplerSampler: sampler");
		expect(wgslCode?.CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION).toContain("uniforms.babylonEditorScenarioLightmapWeight");
		now.mockReturnValue(100);
		scene.onBeforeRenderObservable.notifyObservers(scene);
		expect(mesh.material).toBe(night);
		expect(scene.metadata.babylonEditorActiveLightingScenarioId).toBe("night");
		expect(scene.lightProbeVolumes?.evaluate(mesh, new Vector3(5, 5, 5))?.coefficients[0]).toBe(3);
		expect(controller.inspect()).toMatchObject({ blending: false, activeScenarioId: "night", weight: 0 });
	});
});

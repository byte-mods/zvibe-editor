import "@babylonjs/core/Loading/Plugins/babylonFileLoader";
import "@babylonjs/core/Materials/imageProcessingConfiguration";

import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { RectAreaLight } from "@babylonjs/core/Lights/rectAreaLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { MultiMaterial } from "@babylonjs/core/Materials/multiMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { SceneSerializer } from "@babylonjs/core/Misc/sceneSerializer";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, test } from "vitest";
import { Buffer } from "node:buffer";

import { loadSceneAdditive, unloadSceneAdditive } from "../../src/loading/additive-scene";
import { createAreaLight, getAreaLightEvidence } from "../../src/loading/area-lights";
import { getLightCookieEvidence, getLightCookieTexture, setLightCookie } from "../../src/loading/light-cookies";
import { reflectionProbeBlendModel, reflectionProbeMetadataKey } from "../../src/loading/reflection-probes";
import { diffusionProfileAssetType, getSubsurfaceRuntime, setSubsurfaceMaterialMetadata, subsurfaceRuntimeSettingsMetadataKey } from "../../src/rendering/subsurface-scattering";
import { subsurfaceTransportBackend, subsurfaceTransportLightingSignature, subsurfaceTransportMeshSignature } from "../../src/rendering/subsurface-transport";
import { createDefaultECSConfiguration } from "../../src/ecs/model";
import { getECSRuntime } from "../../src/ecs/runtime";

const redPixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgQIAH8ZV8QAAAABJRU5ErkJggg==";

function createSerializedScene(id = "additive-mesh", name = "Additive mesh"): string {
	const source = new Scene(new NullEngine());
	source.metadata = {
		name: "Additive configuration",
		scripts: [{ key: "scene-script", enabled: true, values: {} }],
	};
	source.clearColor = new Color4(0.1, 0.2, 0.3, 1);
	const mesh = new Mesh(name, source);
	mesh.id = id;
	mesh.metadata = { scripts: [{ key: "mesh-script", enabled: true, values: {} }] };
	mesh.material = new StandardMaterial("Additive material", source);
	const serialized = SceneSerializer.Serialize(source);
	source.dispose();
	return `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
}

function createSerializedECSScene(revision = 0): string {
	const source = new Scene(new NullEngine());
	const configuration = createDefaultECSConfiguration();
	configuration.revision = revision;
	source.metadata = { babylonEditorECS: configuration };
	const mesh = new Mesh("Additive ECS entity", source);
	mesh.id = "additive-ecs-entity";
	mesh.metadata = {
		babylonEditorComponentStack: {
			version: 1,
			components: [
				{
					id: "entity-additive",
					type: "entity",
					enabled: true,
					data: { version: 2, archetype: "Unit", sectionId: "main", values: {}, components: {}, bakingEnabled: true },
				},
			],
		},
	};
	const serialized = SceneSerializer.Serialize(source);
	source.dispose();
	return `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
}

function createSerializedCookieScene(): string {
	const source = new Scene(new NullEngine());
	const light = new DirectionalLight("Additive cookie light", new Vector3(0, -1, 0), source);
	light.id = "additive-cookie-light";
	const texture = new Texture(redPixelPng, source);
	texture.name = "additive-cookie.png";
	setLightCookie(light, texture, { intensity: 0.65, size: [320, 180], offset: [0.25, -0.125] });
	const serialized = SceneSerializer.Serialize(source);
	source.dispose();
	return `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
}

function createSerializedAreaLightScene(): string {
	const source = new Scene(new NullEngine());
	const light = createAreaLight("Additive disc area light", new Vector3(10, 20, 30), "disc", source, {
		radius: 75,
		direction: [0, -1, 0],
		upDirection: [0, 0, 1],
	});
	light.id = "additive-disc-area-light";
	light.intensity = 2.5;
	light.range = 900;
	const serialized = SceneSerializer.Serialize(source);
	source.dispose();
	return `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
}

function createSerializedSubsurfaceScene(): string {
	const source = new Scene(new NullEngine());
	const mesh = CreateBox("Additive Skin Mesh", { size: 100 }, source);
	mesh.id = "additive-skin-mesh";
	const material = new PBRMaterial("Additive Skin Material", source);
	material.id = "additive-skin-material";
	setSubsurfaceMaterialMetadata(material, {
		version: 3,
		revision: 4,
		mode: "subsurface-scattering",
		profile: {
			version: 1,
			type: diffusionProfileAssetType,
			id: "additive-skin-profile",
			name: "Additive Skin",
			revision: 2,
			scatteringDistance: [1.2, 0.45, 0.2],
			transmissionTint: [1, 0.4, 0.25],
			thicknessRemap: [0.1, 6],
			worldScale: 1,
			indexOfRefraction: 1.4,
			path: "assets/Additive Skin.diffusionprofile.json",
			contentRevision: "a".repeat(64),
		},
		subsurfaceMask: 0.75,
		subsurfaceMaskTexture: { name: "additive-skin-mask.png", url: redPixelPng, noMipmap: true, invertY: false },
		transmissionEnabled: true,
		transmissionIntensity: 0.8,
		thicknessMultiplier: 2,
		useThicknessTexture: false,
		transportCaches: [
			{
				version: 1,
				backend: subsurfaceTransportBackend,
				ownership: "editor-generated",
				revision: 1,
				meshId: mesh.id,
				meshName: mesh.name,
				texture: { name: "additive-skin-transport.png", url: redPixelPng, noMipmap: true, invertY: false },
				texturePath: "assets/Lighting/Subsurface/additive-skin-transport.png",
				contentRevision: "b".repeat(64),
				uvChannel: "uv0",
				resolution: 16,
				sampleCount: 4,
				maxDistance: 1000,
				bias: 0.01,
				shadowing: true,
				dilation: 2,
				encoding: "linear-rgbm8",
				rgbmRange: 16,
				intensity: 1,
				profileId: "additive-skin-profile",
				profileRevision: 2,
				profileContentRevision: "a".repeat(64),
				geometrySignature: subsurfaceTransportMeshSignature(mesh, "uv0"),
				lightingSignature: subsurfaceTransportLightingSignature(source),
				coveredTexels: 128,
				overlapTexels: 0,
				tracedTexels: 128,
				hitTexels: 120,
				rayCount: 512,
				minimumThickness: 90,
				maximumThickness: 110,
				averageThickness: 100,
				limitations: ["Static bounded cache."],
			},
		],
	});
	mesh.material = material;
	const serialized = SceneSerializer.Serialize(source);
	source.dispose();
	return `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
}

function createSerializedReflectionProbeBlendScene(): string {
	const source = new Scene(new NullEngine());
	const mesh = new Mesh("Additive probe receiver", source);
	mesh.id = "additive-probe-mesh";
	const material = new PBRMaterial("Additive probe material", source);
	material.id = "additive-probe-material";
	mesh.material = material;
	const probes = [
		{ name: "Additive blue probe", id: "additive-blue-probe", position: [-25, 0, 0] as [number, number, number], importance: 5, blendDistance: 25 },
		{ name: "Additive red probe", id: "additive-red-probe", position: [25, 0, 0] as [number, number, number], importance: 5, blendDistance: 40 },
	].map((definition) => {
		const probe = new ReflectionProbe(definition.name, 32, source, true, false, true);
		probe.position.copyFromFloats(...definition.position);
		probe.renderList = [];
		probe.metadata = {
			[reflectionProbeMetadataKey]: {
				version: 2,
				id: definition.id,
				revision: 3,
				intensity: 0.8,
				boxProjection: true,
				influencePosition: definition.position,
				influenceSize: [200, 160, 120],
				importance: definition.importance,
				blendDistance: definition.blendDistance,
				assignedMaterialIds: [material.id],
			},
		};
		return probe;
	});
	material.reflectionTexture = probes[0].cubeTexture;
	const serialized = SceneSerializer.Serialize(source);
	source.dispose();
	return `data:application/json;base64,${Buffer.from(JSON.stringify(serialized)).toString("base64")}`;
}

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
	(scene as any)._prePassRenderer = { update: () => undefined, defaultRT: { enabled: true } };
	(scene as any)._subSurfaceConfiguration = configuration;
	(scene as any).enableSubSurfaceForPrePass = () => configuration;
}

describe("runtime additive scene lifecycle", () => {
	test("loads exact scene content without replacing the running scene configuration and unloads idempotently", async () => {
		const scene = new Scene(new NullEngine());
		const baseMetadata = { name: "Base configuration" };
		scene.metadata = baseMetadata;
		scene.clearColor = new Color4(0.9, 0.8, 0.7, 1);
		const baseCamera = new ArcRotateCamera("Base camera", 0, 0, 10, Vector3.Zero(), scene);
		scene.activeCamera = baseCamera;
		const baseMesh = new Mesh("Base mesh", scene);

		let starts = 0;
		let stops = 0;
		const handle = await loadSceneAdditive("", createSerializedScene(), scene, {
			"scene-script": {
				onStart: () => starts++,
				onStop: () => stops++,
			},
			"mesh-script": {
				onStart: () => starts++,
				onStop: () => stops++,
			},
		});

		expect(handle.state).toBe("loaded");
		expect(handle.rootNodes.map((node) => node.name)).toEqual(["Additive mesh"]);
		expect(handle.getNodeById("additive-mesh")?.name).toBe("Additive mesh");
		expect(handle.resourceCounts).toMatchObject({ meshes: 1, materials: 1 });
		expect(scene.metadata).toMatchObject(baseMetadata);
		expect(scene.metadata.scripts).toBeUndefined();
		expect(scene.clearColor.asArray()).toEqual([0.9, 0.8, 0.7, 1]);
		expect(scene.activeCamera).toBe(baseCamera);
		expect(scene.meshes).toContain(baseMesh);
		expect(scene.getMeshById("additive-mesh")).not.toBeNull();

		scene.render();
		expect(starts).toBe(2);

		const first = await handle.unload();
		expect(first).toMatchObject({ unloaded: true, retainedSharedResources: 0 });
		expect(handle.state).toBe("unloaded");
		expect(scene.getMeshById("additive-mesh")).toBeNull();
		expect(scene.meshes).toContain(baseMesh);
		expect(scene.activeCamera).toBe(baseCamera);
		expect(scene.metadata).toBe(baseMetadata);
		expect(stops).toBe(2);

		const second = await unloadSceneAdditive(handle);
		expect(second).toEqual(first);
		scene.dispose();
	});

	test("serializes concurrent loads and supports unloading handles in any order", async () => {
		const scene = new Scene(new NullEngine());
		const [first, second] = await Promise.all([
			loadSceneAdditive("", createSerializedScene("first", "First"), scene, {}),
			loadSceneAdditive("", createSerializedScene("second", "Second"), scene, {}),
		]);
		expect(scene.getMeshById("first")?.name).toBe("First");
		expect(scene.getMeshById("second")?.name).toBe("Second");

		await first.unload();
		expect(scene.getMeshById("first")).toBeNull();
		expect(scene.getMeshById("second")?.name).toBe("Second");
		await second.unload();
		expect(scene.meshes).toHaveLength(0);
		scene.dispose();
	});

	test("refreshes one scene-wide ECS runtime across additive load and unload", async () => {
		const scene = new Scene(new NullEngine());
		scene.metadata = { babylonEditorECS: createDefaultECSConfiguration() };
		const handle = await loadSceneAdditive("", createSerializedECSScene(), scene, {});
		expect(getECSRuntime(scene)?.world).toMatchObject({ entityCount: 1, activeEntityCount: 1 });
		expect(getECSRuntime(scene)?.world.sourceLeases["additive-ecs-entity"]).toBeDefined();
		await handle.unload();
		expect(getECSRuntime(scene)?.world.entityCount).toBe(0);
		scene.dispose();
	});

	test("rejects additive content with a conflicting scene-wide ECS contract", async () => {
		const scene = new Scene(new NullEngine());
		scene.metadata = { babylonEditorECS: createDefaultECSConfiguration() };
		await expect(loadSceneAdditive("", createSerializedECSScene(1), scene, {})).rejects.toThrow("ECS configuration differs");
		expect(scene.getMeshById("additive-ecs-entity")).toBeNull();
		scene.dispose();
	});

	test("rejects ambiguous duplicate node ids without changing the running scene", async () => {
		const scene = new Scene(new NullEngine());
		const base = new Mesh("Base", scene);
		base.id = "duplicate";

		await expect(loadSceneAdditive("", createSerializedScene("duplicate", "Duplicate"), scene, {})).rejects.toThrow('node id "duplicate" is already present');
		expect(scene.meshes).toEqual([base]);
		scene.dispose();
	});

	test("retains an additive material when content outside the handle starts sharing it", async () => {
		const scene = new Scene(new NullEngine());
		const baseMesh = new Mesh("Base mesh", scene);
		const handle = await loadSceneAdditive("", createSerializedScene(), scene, {});
		const material = scene.getMaterialByName("Additive material")!;
		const additiveMesh = scene.getMeshById("additive-mesh")!;
		const sharedMultiMaterial = new MultiMaterial("Base multi material", scene);
		sharedMultiMaterial.subMaterials.push(material);
		baseMesh.material = sharedMultiMaterial;
		baseMesh.position.set(2, 3, 4);
		baseMesh.setParent(additiveMesh);
		const worldPosition = baseMesh.getAbsolutePosition().clone();

		const result = await handle.unload();

		expect(result.retainedSharedResources).toBe(1);
		expect(scene.materials).toContain(material);
		expect(baseMesh.material).toBe(sharedMultiMaterial);
		expect(sharedMultiMaterial.subMaterials).toContain(material);
		expect(baseMesh.isDisposed()).toBe(false);
		expect(baseMesh.parent).toBeNull();
		expect(baseMesh.getAbsolutePosition().asArray()).toEqual(worldPosition.asArray());
		scene.dispose();
	});

	test("rehydrates and owns a directional light cookie for additive load and unload", async () => {
		const scene = new Scene(new NullEngine());
		const handle = await loadSceneAdditive("", createSerializedCookieScene(), scene, {});
		const light = scene.getLightById("additive-cookie-light")!;
		const texture = getLightCookieTexture(light);

		expect(getLightCookieEvidence(light)).toMatchObject({
			backend: "unity-style-light-cookie-v1",
			kind: "directional-2d",
			revision: 1,
			intensity: 0.65,
			size: [320, 180],
			offset: [0.25, -0.125],
			textureName: "additive-cookie.png",
			textureIsCube: false,
		});
		expect(texture).not.toBeNull();
		expect(handle.resourceCounts).toMatchObject({ lights: 1, textures: 1 });

		await handle.unload();
		expect(scene.getLightById("additive-cookie-light")).toBeNull();
		expect(scene.textures).not.toContain(texture);
		scene.dispose();
	});

	test("rehydrates and owns a Unity-style disc area light for additive load and unload", async () => {
		const scene = new Scene(new NullEngine());
		const handle = await loadSceneAdditive("", createSerializedAreaLightScene(), scene, {});
		const light = scene.getLightById("additive-disc-area-light")!;

		expect(getAreaLightEvidence(light as RectAreaLight)).toMatchObject({
			backend: "unity-style-area-light-v1",
			shape: "disc",
			revision: 1,
			radius: 75,
			position: [10, 20, 30],
			worldDirection: [0, -1, 0],
			worldUp: [0, 0, 1],
			intensity: 2.5,
			range: 900,
			oneSided: true,
			nativeForwardModel: "bounded-ltc-disc-rectangle",
			deferredModel: "bounded-ltc-disc-16-gon",
			bakedModel: "deterministic-concentric-disc",
			castsRealtimeShadows: false,
		});
		expect(handle.resourceCounts).toMatchObject({ lights: 1 });

		await handle.unload();
		expect(scene.getLightById("additive-disc-area-light")).toBeNull();
		scene.dispose();
	});

	test("preserves overlapping version-2 reflection-probe blend metadata and exact additive ownership", async () => {
		const scene = new Scene(new NullEngine());
		const handle = await loadSceneAdditive("", createSerializedReflectionProbeBlendScene(), scene, {});
		const probes = ((scene as Scene & { reflectionProbes?: ReflectionProbe[] }).reflectionProbes ?? []).sort((left, right) => left.name.localeCompare(right.name));

		expect(probes).toHaveLength(2);
		expect(
			probes.map((probe) => ({
				name: probe.name,
				metadata: probe.metadata?.[reflectionProbeMetadataKey],
				boxPosition: probe.cubeTexture.boundingBoxPosition?.asArray(),
				boxSize: probe.cubeTexture.boundingBoxSize?.asArray(),
			}))
		).toEqual([
			{
				name: "Additive blue probe",
				metadata: expect.objectContaining({
					version: 2,
					id: "additive-blue-probe",
					revision: 3,
					importance: 5,
					blendDistance: 25,
					assignedMaterialIds: ["additive-probe-material"],
				}),
				boxPosition: [-25, 0, 0],
				boxSize: [200, 160, 120],
			},
			{
				name: "Additive red probe",
				metadata: expect.objectContaining({
					version: 2,
					id: "additive-red-probe",
					revision: 3,
					importance: 5,
					blendDistance: 40,
					assignedMaterialIds: ["additive-probe-material"],
				}),
				boxPosition: [25, 0, 0],
				boxSize: [200, 160, 120],
			},
		]);
		expect(reflectionProbeBlendModel).toBe("unity-priority-box-blend-skybox-v1");

		await handle.unload();
		expect((scene as Scene & { reflectionProbes?: ReflectionProbe[] }).reflectionProbes ?? []).toHaveLength(0);
		expect(scene.getMaterialById("additive-probe-material")).toBeNull();
		expect(scene.getMeshById("additive-probe-mesh")).toBeNull();
		scene.dispose();
	});

	test("rehydrates portable subsurface material metadata and recomposes native execution after additive unload", async () => {
		const scene = new Scene(new NullEngine());
		installSubsurfacePrePass(scene);
		scene.metadata = {
			[subsurfaceRuntimeSettingsMetadataKey]: {
				version: 2,
				revision: 1,
				enabled: true,
				quality: "high",
				sampleBudget: 64,
				metersPerUnit: 0.01,
				transportMode: "baked-ray-traced",
				transportIntensity: 1,
			},
		};
		const handle = await loadSceneAdditive("", createSerializedSubsurfaceScene(), scene, {});
		const material = scene.getMaterialById("additive-skin-material") as PBRMaterial;

		expect(material.metadata).toMatchObject({
			babylonEditorSubsurfaceScattering: { revision: 4, profile: { id: "additive-skin-profile", revision: 2 } },
		});
		expect(getSubsurfaceRuntime(scene)).toMatchObject({
			configured: true,
			ready: false,
			profileCount: 1,
			materialCount: 1,
			maskTargetAllocated: true,
			maskTextureCount: 1,
			transport: { enabled: true, ready: true, cacheCount: 1, activeCacheCount: 1, staleCacheCount: 0, totalRayCount: 512 },
			materials: [expect.objectContaining({ materialId: "additive-skin-material", revision: 4, subsurfaceMaskTextureName: "additive-skin-mask.png" })],
		});

		await handle.unload();
		expect(scene.getMaterialById("additive-skin-material")).toBeNull();
		expect(getSubsurfaceRuntime(scene)).toMatchObject({ configured: false, ready: false, materialCount: 0, transport: { cacheCount: 0, activeCacheCount: 0 } });
		scene.dispose();
	});

	test("rolls back loaded resources when runtime configuration throws", async () => {
		const scene = new Scene(new NullEngine());
		const baseMesh = new Mesh("Base mesh", scene);
		class BrokenScript {
			public constructor() {
				throw new Error("broken additive script");
			}
		}

		await expect(
			loadSceneAdditive("", createSerializedScene(), scene, {
				"mesh-script": { default: BrokenScript },
			})
		).rejects.toThrow("broken additive script");
		expect(scene.meshes).toEqual([baseMesh]);
		expect(scene.getMaterialByName("Additive material")).toBeNull();
		scene.dispose();
	});
});

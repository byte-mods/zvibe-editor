import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { DirectionalLight } from "@babylonjs/core/Lights/directionalLight";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { SpotLight } from "@babylonjs/core/Lights/spotLight";
import { CascadedShadowGenerator } from "@babylonjs/core/Lights/Shadows/cascadedShadowGenerator";
import { ShadowGenerator } from "@babylonjs/core/Lights/Shadows/shadowGenerator";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { OpenPBRMaterial } from "@babylonjs/core/Materials/PBR/openpbrMaterial";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { PBRMetallicRoughnessMaterial } from "@babylonjs/core/Materials/PBR/pbrMetallicRoughnessMaterial";
import { PBRSpecularGlossinessMaterial } from "@babylonjs/core/Materials/PBR/pbrSpecularGlossinessMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { CreateDecal } from "@babylonjs/core/Meshes/Builders/decalBuilder";
import type { GeometryBufferRenderer } from "@babylonjs/core/Rendering/geometryBufferRenderer";
import { ReflectionProbe } from "@babylonjs/core/Probes/reflectionProbe";
import { Scene } from "@babylonjs/core/scene";

import { configureDeferredLighting, getDeferredLightingRuntime, inspectDeferredLightingCompatibility, stopDeferredLighting } from "../../src/rendering/deferred-lighting";
import { getLightCookieEvidence, setLightCookie } from "../../src/loading/light-cookies";
import { createAreaLight, getAreaLightEvidence, setAreaLightProperties } from "../../src/loading/area-lights";

function installGeometryBuffer(scene: Scene): GeometryBufferRenderer {
	const textures = [
		RawTexture.CreateRGBATexture(new Uint8Array([0, 0, 0, 255]), 1, 1, scene),
		RawTexture.CreateRGBATexture(new Uint8Array([128, 128, 255, 255]), 1, 1, scene),
		RawTexture.CreateRGBATexture(new Uint8Array([10, 10, 10, 255]), 1, 1, scene),
	];
	const target = { textures, count: 3, getSize: () => ({ width: 320, height: 180 }), isReady: () => true };
	const renderer = {
		isSupported: true,
		normalsAreUnsigned: true,
		enableDepth: true,
		enableNormal: true,
		enablePosition: false,
		enableVelocity: false,
		enableVelocityLinear: false,
		enableReflectivity: false,
		enableScreenspaceDepth: false,
		enableIrradiance: false,
		getGBuffer: () => target,
		getTextureIndex: (type: number) => (type === 2 ? 0 : type === 1 ? 1 : type === 4 ? 2 : -1),
	} as unknown as GeometryBufferRenderer;
	scene.enableGeometryBufferRenderer = () => {
		(scene as unknown as { _geometryBufferRenderer: GeometryBufferRenderer | null })._geometryBufferRenderer = renderer;
		return renderer;
	};
	scene.disableGeometryBufferRenderer = () => {
		(scene as unknown as { _geometryBufferRenderer: GeometryBufferRenderer | null })._geometryBufferRenderer = null;
	};
	return renderer;
}

describe("rendering/deferred-lighting", () => {
	let engine: NullEngine;
	let scene: Scene;
	let camera: FreeCamera;

	beforeEach(() => {
		engine = new NullEngine();
		engine.getCaps().drawBuffersExtension = true;
		engine.getCaps().maxDrawBuffers = 8;
		scene = new Scene(engine);
		camera = new FreeCamera("Deferred Camera", new Vector3(0, 0, -500), scene);
		camera.setTarget(Vector3.Zero());
		scene.activeCamera = camera;
		const box = CreateBox("Deferred Box", { size: 100 }, scene);
		box.material = new StandardMaterial("Deferred Standard", scene);
		new PointLight("Deferred Point", new Vector3(0, 200, -200), scene);
	});

	afterEach(() => {
		stopDeferredLighting(scene);
		scene.dispose();
		engine.dispose();
	});

	test("corrects Babylon's low-quality WGSL CSM blend call without editing the installed engine", () => {
		expect(ShaderStore.IncludesShadersStoreWGSL.lightFragment).not.toContain("vDepthMetric{X}[index{X}],,shadowTexture{X}Sampler");
		expect(ShaderStore.IncludesShadersStoreWGSL.lightFragment).toContain("vDepthMetric{X}[index{X}],shadowTexture{X},shadowTexture{X}Sampler");
	});

	test("classifies transparent meshes for native forward composition while reporting backend incompatibility", () => {
		engine.getCaps().drawBuffersExtension = false;
		(scene.meshes[0].material as StandardMaterial).alpha = 0.5;
		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([expect.stringContaining("four simultaneous draw buffers")]);
		expect(compatibility).toMatchObject({ meshes: [], forwardMeshes: [scene.meshes[0]], transparentMeshCount: 1 });
		const runtime = configureDeferredLighting(scene, camera);
		expect(runtime).toMatchObject({
			configured: false,
			active: false,
			cameraId: camera.id,
			meshCount: 0,
			materialCount: 0,
			lightCount: 1,
			compositionMode: "hybrid-forward",
			forwardMeshCount: 1,
			transparentMeshCount: 1,
		});
		expect(scene.customRenderTargets).toHaveLength(0);
	});

	test("configures spot, directional, and point cookies with exact deferred evidence and invalidation", () => {
		installGeometryBuffer(scene);
		const point = scene.lights[0] as PointLight;
		const directional = new DirectionalLight("Deferred Directional Cookie", new Vector3(0, 0, 1), scene);
		const spot = new SpotLight("Deferred Spot Cookie", new Vector3(0, 0, -200), new Vector3(0, 0, 1), Math.PI / 2, 2, scene);
		const texture2d = RawTexture.CreateRGBATexture(new Uint8Array([255, 32, 8, 255]), 1, 1, scene);
		texture2d.name = "Deferred Cookie 2D";
		texture2d.isReadyOrNotBlocking = () => true;
		const textureCube = RawTexture.CreateRGBATexture(new Uint8Array([8, 32, 255, 255]), 1, 1, scene);
		(textureCube as unknown as { _texture: { isCube: boolean } })._texture.isCube = true;
		textureCube.name = "Deferred Cookie Cube";
		textureCube.isReadyOrNotBlocking = () => true;
		setLightCookie(point, textureCube, { intensity: 0.75 });
		setLightCookie(directional, texture2d, { size: [200, 300], offset: [0.25, -0.5], upDirection: [0, 1, 0] });
		setLightCookie(spot, texture2d, { near: 0.1, far: 500, intensity: 0.5 });

		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([]);
		expect(compatibility.cookieSources).toHaveLength(3);
		expect(compatibility.cookieSources.map((source) => source.evidence.kind).sort()).toEqual(["directional-2d", "point-cube", "spot-2d"]);
		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			active: true,
			cookieActive: true,
			cookieReady: true,
			cookieCount: 3,
			cookieMaximumSources: 8,
			cookieFrameCount: 0,
		});
		expect(configured.cookieSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ lightId: point.id, kind: "point-cube", intensity: 0.75, textureIsCube: true, revision: 1 }),
				expect.objectContaining({ lightId: directional.id, kind: "directional-2d", size: [200, 300], offset: [0.25, -0.5], revision: 1 }),
				expect.objectContaining({ lightId: spot.id, kind: "spot-2d", near: 0.1, far: 500, intensity: 0.5, revision: 1 }),
			])
		);

		setLightCookie(directional, texture2d, { size: [400, 300] });
		expect(getLightCookieEvidence(directional)).toMatchObject({ revision: 2, size: [400, 300] });
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("deferred light cookie texture, type, revision, intensity, projection size, offset, clip range, or up direction changed")],
		});
		setLightCookie(directional, texture2d, { size: [200, 300], offset: [0.25, -0.5], revision: 1 });
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, cookieReady: true, errors: [] });
	});

	test("configures oriented rectangle and bounded disc area lights with exact deferred invalidation", () => {
		installGeometryBuffer(scene);
		const rectangle = createAreaLight("Deferred Rectangle Area", new Vector3(0, 200, -100), "rectangle", scene, {
			width: 300,
			height: 150,
			direction: [0, -1, 0],
			upDirection: [0, 0, 1],
		});
		rectangle.intensity = 3;
		rectangle.range = 1200;
		const disc = createAreaLight("Deferred Disc Area", new Vector3(200, 100, -100), "disc", scene, {
			radius: 75,
			direction: [-1, -1, 0],
		});

		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([]);
		expect(compatibility.areaLightSources).toEqual([
			expect.objectContaining({
				lightId: rectangle.id,
				shape: "rectangle",
				width: 300,
				height: 150,
				deferredModel: "babylon-ltc-rectangle",
				castsRealtimeShadows: false,
			}),
			expect.objectContaining({ lightId: disc.id, shape: "disc", radius: 75, deferredModel: "bounded-ltc-disc-16-gon" }),
		]);

		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			configured: true,
			active: true,
			areaLightActive: true,
			areaLightReady: false,
			areaLightCount: 2,
			areaLightFrameCount: 0,
			areaLightSources: [
				expect.objectContaining({ lightId: rectangle.id, revision: 1, shape: "rectangle", intensity: 3, range: 1200 }),
				expect.objectContaining({ lightId: disc.id, revision: 1, shape: "disc", radius: 75 }),
			],
		});

		setAreaLightProperties(rectangle, { width: 450 });
		expect(getAreaLightEvidence(rectangle)).toMatchObject({ revision: 2, width: 450 });
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("area-light shape, size, orientation, transform, intensity, range, color, or revision changed")],
		});
		setAreaLightProperties(rectangle, { width: 300, revision: 1 });
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, areaLightCount: 2, errors: [] });
	});

	test("executes alpha-blended projected decals through the shared G-buffer with exact evidence and invalidation", () => {
		const renderer = installGeometryBuffer(scene);
		const source = scene.meshes[0];
		const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 32, 8, 128]), 1, 1, scene);
		texture.name = "Deferred Decal Color Normal";
		texture.hasAlpha = true;
		texture.isReadyOrNotBlocking = () => true;
		const material = new StandardMaterial("Deferred Projected Decal", scene);
		material.diffuseColor = new Color3(1, 0.25, 0.1);
		material.diffuseTexture = texture;
		material.bumpTexture = texture;
		material.alpha = 0.5;
		material.zOffset = -2;
		const decal = CreateDecal("Deferred Alpha Decal", source, {
			localMode: true,
			position: new Vector3(0, 0, -50),
			normal: new Vector3(0, 0, -1),
			size: new Vector3(50, 50, 10),
			angle: 0.25,
		});
		decal.material = material;
		decal.alphaIndex = 7;
		decal.metadata = {
			decal: {
				version: 1,
				revision: 3,
				meshId: source.id,
				position: [0, 0, -50],
				normal: [0, 0, -1],
				sizeX: 50,
				sizeY: 50,
				sizeZ: 10,
				angle: 0.25,
			},
		};

		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([]);
		expect(compatibility.forwardMeshes).toEqual([]);
		expect(compatibility.transparentMeshCount).toBe(0);
		expect(compatibility.meshes).toEqual(expect.arrayContaining([source, decal]));
		expect(compatibility.decalSources).toHaveLength(1);
		expect(compatibility.decalSources[0]).toMatchObject({ mesh: decal, sourceMesh: source, material, revision: 3, alphaMode: "alpha-blend", affectsNormal: true });

		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			active: true,
			decalActive: true,
			decalReady: true,
			decalCount: 1,
			decalSourceMeshCount: 1,
			decalMaterialCount: 1,
			decalTextureCount: 1,
			decalEvidenceTruncated: false,
			decalForwardSubMeshSuppressedCount: 0,
			decalForwardSuppressionFrameCount: 0,
			decalSources: [
				{
					backend: "projected-geometry-gbuffer-v1",
					nodeId: decal.id,
					sourceMeshId: source.id,
					materialId: material.id,
					revision: 3,
					position: [0, 0, -50],
					normal: [0, 0, -1],
					size: [50, 50, 10],
					angle: 0.25,
					alphaMode: "alpha-blend",
					opacity: 0.5,
					alphaIndex: 7,
					zOffset: -2,
					affectsAlbedo: true,
					affectsNormal: true,
					textureNames: [texture.name],
					texturesReady: true,
					vertexCount: expect.any(Number),
					indexCount: expect.any(Number),
					geometryReady: true,
				},
			],
		});
		expect(renderer.renderTransparentMeshes).toBe(true);

		decal.metadata.decal.revision = 4;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("decal projection, geometry, material channel, texture, opacity, or draw-order setting changed")],
		});
		decal.metadata.decal.revision = 3;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });
		material.diffuseColor.g = 0.75;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: false, errors: [expect.stringContaining("decal projection")] });
		material.diffuseColor.g = 0.25;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });

		stopDeferredLighting(scene, camera);
		expect(renderer.renderTransparentMeshes).toBe(false);
	});

	test("projects textured screen-space decal volumes with bounded evidence and exact invalidation", () => {
		installGeometryBuffer(scene);
		const receiver = scene.meshes[0];
		const texture = RawTexture.CreateRGBATexture(new Uint8Array([255, 32, 8, 255]), 1, 1, scene);
		texture.name = "Deferred Volume Projector Texture";
		texture.hasAlpha = true;
		texture.isReadyOrNotBlocking = () => true;
		const material = new StandardMaterial("Deferred Volume Projector Material", scene);
		material.diffuseColor = Color3.White();
		material.diffuseTexture = texture;
		material.alpha = 0.75;
		const projector = CreateBox("Deferred Volume Projector", { size: 1 }, scene);
		projector.position.set(10, 20, -50);
		projector.rotation.set(0.1, 0.2, 0.3);
		projector.scaling.set(80, 60, 40);
		projector.material = material;
		projector.isVisible = false;
		projector.alphaIndex = 9;
		projector.metadata = {
			decal: {
				version: 2,
				revision: 4,
				projectionMode: "screen-space-volume",
				sizeX: 80,
				sizeY: 60,
				sizeZ: 40,
				position: [10, 20, -50],
				rotation: [0.1, 0.2, 0.3],
				edgeFade: 0.25,
				uvScale: [2, 3],
				uvOffset: [0.1, -0.2],
			},
		};
		projector.computeWorldMatrix(true);

		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([]);
		expect(compatibility.meshes).toEqual([receiver]);
		expect(compatibility.decalSources).toHaveLength(1);
		expect(compatibility.decalSources[0]).toMatchObject({
			mesh: projector,
			sourceMesh: null,
			material,
			projectionMode: "screen-space-volume",
			revision: 4,
			edgeFade: 0.25,
			uvScale: [2, 3],
			uvOffset: [0.1, -0.2],
			affectedMeshCount: 1,
		});

		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			active: true,
			decalActive: true,
			decalReady: true,
			decalCount: 1,
			decalGeometryCount: 0,
			decalProjectorCount: 1,
			decalProjectorMaximumSources: 8,
			decalProjectorSamplerCount: 1,
			decalSourceMeshCount: 0,
			decalMaterialCount: 1,
			decalTextureCount: 1,
			decalSources: [
				expect.objectContaining({
					backend: "screen-space-volume-projector-v2",
					projectionMode: "screen-space-volume",
					nodeId: projector.id,
					sourceMeshId: null,
					materialId: material.id,
					revision: 4,
					position: [10, 20, -50],
					rotation: [0.1, 0.2, 0.3],
					size: [80, 60, 40],
					edgeFade: 0.25,
					uvScale: [2, 3],
					uvOffset: [0.1, -0.2],
					projectorTextureName: texture.name,
					projectorTextureReady: true,
					affectedMeshCount: 1,
					vertexCount: 0,
					indexCount: 0,
					geometryReady: true,
				}),
			],
		});

		projector.metadata.decal.edgeFade = 0.5;
		projector.metadata.decal.revision = 5;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("decal projection, geometry, material channel, texture, opacity, or draw-order setting changed")],
		});
		projector.metadata.decal.edgeFade = 0.25;
		projector.metadata.decal.revision = 4;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, decalProjectorCount: 1, errors: [] });
		projector.position.x = 15;
		projector.computeWorldMatrix(true);
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: false, errors: [expect.stringContaining("decal projection")] });
	});

	test("projects all material channels through an exact 32-bit Decal Layer target", () => {
		installGeometryBuffer(scene);
		const excluded = scene.meshes[0];
		excluded.layerMask = 1;
		const included = CreateBox("Deferred Layer-Two Receiver", { size: 100 }, scene);
		included.position.x = 120;
		included.layerMask = 2;
		included.material = new StandardMaterial("Deferred Layer-Two Receiver Material", scene);
		const texture = (name: string, bytes: [number, number, number, number]): RawTexture => {
			const result = RawTexture.CreateRGBATexture(new Uint8Array(bytes), 1, 1, scene);
			result.name = name;
			result.isReadyOrNotBlocking = () => true;
			return result;
		};
		const albedo = texture("Decal Albedo", [220, 40, 10, 255]);
		const normal = texture("Decal Normal", [128, 210, 230, 255]);
		const reflectivity = texture("Decal Reflectivity", [180, 0, 0, 200]);
		const ambientOcclusion = texture("Decal AO", [96, 0, 0, 255]);
		const emissive = texture("Decal Emissive", [10, 120, 255, 255]);
		const material = new StandardMaterial("Deferred Five-Channel Projector Material", scene);
		material.diffuseColor = new Color3(0.8, 0.5, 0.25);
		material.diffuseTexture = albedo;
		material.bumpTexture = normal;
		material.specularTexture = reflectivity;
		material.ambientTexture = ambientOcclusion;
		material.emissiveColor = new Color3(0.1, 0.2, 0.4);
		material.emissiveTexture = emissive;
		material.alpha = 0.8;
		const projector = CreateBox("Deferred Five-Channel Layer Projector", { size: 1 }, scene);
		projector.scaling.set(500, 500, 500);
		projector.material = material;
		projector.isVisible = false;
		projector.metadata = {
			decal: {
				version: 3,
				revision: 7,
				projectionMode: "screen-space-volume",
				sizeX: 500,
				sizeY: 500,
				sizeZ: 500,
				edgeFade: 0.1,
				uvScale: [1, 1],
				uvOffset: [0, 0],
				channels: { albedo: true, normal: true, metallic: true, ambientOcclusion: true, emissive: true },
				normalStrength: 1.25,
				metallic: 0.75,
				smoothness: 0.8,
				ambientOcclusion: 0.6,
				emissiveIntensity: 2.5,
				decalLayerMask: 2,
			},
		};
		projector.computeWorldMatrix(true);

		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([]);
		expect(compatibility.decalSources[0]).toMatchObject({
			channels: { albedo: true, normal: true, metallic: true, ambientOcclusion: true, emissive: true },
			normalStrength: 1.25,
			metallic: 0.75,
			smoothness: 0.8,
			ambientOcclusion: 0.6,
			emissiveIntensity: 2.5,
			decalLayerMask: 2,
			affectedMeshCount: 1,
			affectedMeshIds: [included.uniqueId],
		});

		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			active: true,
			ready: false,
			decalProjectorCount: 1,
			decalProjectorSamplerCount: 6,
			decalLayerFilteredProjectorCount: 1,
			decalLayerTargetReady: false,
			decalLayerTargetWidth: 512,
			decalLayerTargetHeight: 256,
			decalSources: [
				expect.objectContaining({
					backend: "screen-space-volume-projector-v2",
					affectsNormal: true,
					affectsReflectivity: true,
					affectsAmbientOcclusion: true,
					affectsEmissive: true,
					projectorTextureNames: {
						albedo: albedo.name,
						normal: normal.name,
						reflectivity: reflectivity.name,
						ambientOcclusion: ambientOcclusion.name,
						emissive: emissive.name,
					},
					projectorTexturesReady: true,
				}),
			],
		});
		const layerTarget = scene.customRenderTargets.find((target) => target.name === "Babylon Editor Deferred Decal Layers");
		expect(layerTarget?.renderList?.map((mesh) => mesh.uniqueId)).toEqual([excluded.uniqueId, included.uniqueId]);
		included.layerMask = 6;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: false, errors: [expect.stringContaining("decal projection")] });
		included.layerMask = 2;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });
		stopDeferredLighting(scene, camera);
		expect(scene.customRenderTargets).toHaveLength(0);
		projector.metadata.decal.channels = { albedo: false, normal: false, metallic: false, ambientOcclusion: false, emissive: false };
		expect(inspectDeferredLightingCompatibility(scene, camera).errors).toContain(
			'Screen-space decal projector "Deferred Five-Channel Layer Projector" requires at least one enabled material channel.'
		);
	});

	test("preserves color and textured emissive output for every supported material family with exact invalidation and cleanup", () => {
		installGeometryBuffer(scene);
		const standard = scene.meshes[0].material as StandardMaterial;
		standard.emissiveColor = new Color3(4, 0.1, 0.2);
		const emissiveTexture = RawTexture.CreateRGBATexture(new Uint8Array([0, 255, 32, 255]), 1, 1, scene);
		emissiveTexture.name = "Deferred Emissive Texture";

		const pbr = new PBRMaterial("Deferred Emissive PBR", scene);
		pbr.emissiveColor = new Color3(0.1, 3, 0.2);
		pbr.emissiveTexture = emissiveTexture;
		pbr.emissiveIntensity = 2;
		const pbrMesh = CreateBox("Deferred Emissive PBR Box", { size: 10 }, scene);
		pbrMesh.material = pbr;

		const metallicRoughness = new PBRMetallicRoughnessMaterial("Deferred Emissive Metallic Roughness", scene);
		metallicRoughness.emissiveColor = new Color3(0.1, 0.2, 2);
		const metallicRoughnessMesh = CreateBox("Deferred Emissive Metallic Roughness Box", { size: 10 }, scene);
		metallicRoughnessMesh.material = metallicRoughness;

		const specularGlossiness = new PBRSpecularGlossinessMaterial("Deferred Emissive Specular Glossiness", scene);
		specularGlossiness.emissiveColor = new Color3(2, 1, 0.1);
		const specularGlossinessMesh = CreateBox("Deferred Emissive Specular Glossiness Box", { size: 10 }, scene);
		specularGlossinessMesh.material = specularGlossiness;

		const openPbr = new OpenPBRMaterial("Deferred Emissive OpenPBR", scene);
		openPbr.emissionColor = new Color3(1, 0.1, 2);
		openPbr.emissionLuminance = 3;
		const openPbrMesh = CreateBox("Deferred Emissive OpenPBR Box", { size: 10 }, scene);
		openPbrMesh.material = openPbr;

		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([]);
		expect(compatibility.emissiveSources).toHaveLength(5);
		expect(compatibility.emissiveSources.map((source) => source.material.getClassName()).sort()).toEqual(
			["OpenPBRMaterial", "PBRMaterial", "PBRMetallicRoughnessMaterial", "PBRSpecularGlossinessMaterial", "StandardMaterial"].sort()
		);

		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			configured: true,
			active: true,
			emissiveActive: true,
			emissiveMeshCount: 5,
			emissiveMaterialCount: 5,
			emissiveTextureCount: 1,
			emissiveEvidenceTruncated: false,
		});
		expect(configured.emissiveSources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ materialId: standard.id, color: [4, 0.1, 0.2], intensity: 1, textureName: null, meshCount: 1 }),
				expect.objectContaining({ materialId: pbr.id, color: [0.1, 3, 0.2], intensity: 2, textureName: emissiveTexture.name }),
				expect.objectContaining({ materialId: openPbr.id, color: [1, 0.1, 2], intensity: 3, textureName: null }),
			])
		);
		expect(scene.customRenderTargets.map((target) => target.name)).toEqual(["Babylon Editor Deferred Albedo", "Babylon Editor Deferred Emissive"]);
		const emissiveTarget = scene.customRenderTargets[1];
		expect(emissiveTarget.renderList).toHaveLength(5);
		expect(scene.materials.filter((material) => material.doNotSerialize && material.name.startsWith("Deferred Emissive ·"))).toHaveLength(5);

		pbr.emissiveIntensity = 4;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("emissive material color, texture, intensity, or mesh assignment changed")],
		});
		pbr.emissiveIntensity = 2;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });
		scene.customRenderTargets.splice(scene.customRenderTargets.indexOf(emissiveTarget), 1);
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			errors: [expect.stringContaining("deferred emissive target was removed")],
		});
		scene.customRenderTargets.push(emissiveTarget);
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });

		const stopped = stopDeferredLighting(scene, camera);
		expect(stopped).toMatchObject({ configured: false, emissiveActive: false, emissiveSources: [] });
		expect(scene.customRenderTargets).toHaveLength(0);
		expect(scene.materials.filter((material) => material.doNotSerialize && material.name.startsWith("Deferred Emissive ·"))).toHaveLength(0);
	});

	test("accepts every native classic 2D shadow filter and rejects unknown filtering", () => {
		const box = scene.meshes[0];
		box.receiveShadows = true;
		const directional = new DirectionalLight("Deferred Shadow Directional", new Vector3(0, -1, 1), scene);
		const shadowMap = { renderList: [box], getSize: () => ({ width: 1024, height: 1024 }), isReadyForRendering: () => true };
		const generator = {
			filter: ShadowGenerator.FILTER_PCF,
			getClassName: () => "ShadowGenerator",
			getShadowMap: () => shadowMap,
			getShadowMapForRendering: () => shadowMap,
		} as unknown as ShadowGenerator;
		(directional as unknown as { getShadowGenerator: () => ShadowGenerator }).getShadowGenerator = () => generator;

		const filters = [
			[ShadowGenerator.FILTER_NONE, "classic-hard"],
			[ShadowGenerator.FILTER_POISSONSAMPLING, "classic-poisson"],
			[ShadowGenerator.FILTER_EXPONENTIALSHADOWMAP, "classic-esm"],
			[ShadowGenerator.FILTER_BLUREXPONENTIALSHADOWMAP, "classic-blur-esm"],
			[ShadowGenerator.FILTER_CLOSEEXPONENTIALSHADOWMAP, "classic-close-esm"],
			[ShadowGenerator.FILTER_BLURCLOSEEXPONENTIALSHADOWMAP, "classic-blur-close-esm"],
			[ShadowGenerator.FILTER_PCF, "classic-pcf"],
			[ShadowGenerator.FILTER_PCSS, "classic-pcss"],
		] as const;
		for (const [filter, shadowMode] of filters) {
			generator.filter = filter;
			expect(inspectDeferredLightingCompatibility(scene, camera)).toMatchObject({
				errors: [],
				shadowGenerator: generator,
				shadowLight: directional,
				shadowMode,
				shadowReceiverMeshes: [box],
			});
		}

		generator.filter = 99;
		expect(inspectDeferredLightingCompatibility(scene, camera)).toMatchObject({
			shadowGenerator: null,
			errors: [expect.stringContaining("unknown classic shadow filter 99")],
		});
	});

	test("accepts native point cube soft filters and directional cascaded hard, PCF, and PCSS resources", () => {
		const box = scene.meshes[0];
		box.receiveShadows = true;
		const point = scene.lights.find((light): light is PointLight => light instanceof PointLight)!;
		const cubeMap = { renderList: [box], getSize: () => ({ width: 512, height: 512 }), isReadyForRendering: () => true };
		const cubeGenerator = {
			filter: ShadowGenerator.FILTER_NONE,
			getClassName: () => "ShadowGenerator",
			getShadowMap: () => cubeMap,
			getShadowMapForRendering: () => cubeMap,
		} as unknown as ShadowGenerator;
		(point as unknown as { getShadowGenerator: () => ShadowGenerator }).getShadowGenerator = () => cubeGenerator;

		for (const [filter, shadowMode] of [
			[ShadowGenerator.FILTER_NONE, "point-cube-hard"],
			[ShadowGenerator.FILTER_POISSONSAMPLING, "point-cube-poisson"],
			[ShadowGenerator.FILTER_EXPONENTIALSHADOWMAP, "point-cube-esm"],
			[ShadowGenerator.FILTER_CLOSEEXPONENTIALSHADOWMAP, "point-cube-close-esm"],
		] as const) {
			cubeGenerator.filter = filter;
			expect(inspectDeferredLightingCompatibility(scene, camera)).toMatchObject({
				shadowGenerator: cubeGenerator,
				shadowLight: point,
				shadowMode,
				shadowReceiverMeshes: [box],
			});
		}

		point.setEnabled(false);
		const directional = new DirectionalLight("Deferred Cascaded Directional", new Vector3(0, -1, 1), scene);
		const cascadeMap = { renderList: [box], getSize: () => ({ width: 1024, height: 1024 }), isReadyForRendering: () => true };
		const cascadedGenerator = {
			filter: ShadowGenerator.FILTER_PCF,
			numCascades: 4,
			getClassName: () => "CascadedShadowGenerator",
			getShadowMap: () => cascadeMap,
			getShadowMapForRendering: () => cascadeMap,
		} as unknown as CascadedShadowGenerator;
		(directional as unknown as { getShadowGenerator: (requestedCamera?: FreeCamera | null) => CascadedShadowGenerator | null }).getShadowGenerator = (
			requestedCamera = null
		) => (requestedCamera === camera ? cascadedGenerator : null);

		for (const [filter, shadowMode] of [
			[ShadowGenerator.FILTER_NONE, "cascaded-hard"],
			[ShadowGenerator.FILTER_PCF, "cascaded-pcf"],
			[ShadowGenerator.FILTER_PCSS, "cascaded-pcss"],
		] as const) {
			cascadedGenerator.filter = filter;
			expect(inspectDeferredLightingCompatibility(scene, camera)).toMatchObject({
				shadowGenerator: cascadedGenerator,
				shadowLight: directional,
				shadowMode,
				shadowReceiverMeshes: [box],
			});
		}
	});

	test("configures multiple simultaneous heterogeneous shadowed lights with exact source and sampler evidence", () => {
		installGeometryBuffer(scene);
		const box = scene.meshes[0];
		box.receiveShadows = true;
		const point = scene.lights.find((light): light is PointLight => light instanceof PointLight)!;
		const pointGenerator = new ShadowGenerator(256, point, true);
		pointGenerator.usePoissonSampling = true;
		pointGenerator.getShadowMap()!.renderList = [box];
		const spot = new SpotLight("Deferred Shadow Spot", new Vector3(120, 200, -200), new Vector3(-0.4, -0.6, 1), Math.PI / 2, 2, scene);
		const spotGenerator = new ShadowGenerator(512, spot, true);
		spotGenerator.usePercentageCloserFiltering = true;
		Object.defineProperty(spotGenerator, "filter", { configurable: true, value: ShadowGenerator.FILTER_PCF, writable: true });
		spotGenerator.getShadowMap()!.renderList = [box];

		const compatibility = inspectDeferredLightingCompatibility(scene, camera);
		expect(compatibility.errors).toEqual([]);
		expect(compatibility.shadowSources.map((source) => [source.light.id, source.generator === pointGenerator || source.generator === spotGenerator, source.mode])).toEqual([
			[point.id, true, "point-cube-poisson"],
			[spot.id, true, "classic-pcf"],
		]);
		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			active: true,
			shadowLightCount: 2,
			shadowMaximumSources: 8,
			shadowMapCount: 7,
			shadowSamplerCount: 3,
			shadowMapReady: false,
			shadowCasterCount: 2,
			shadowReceiverCount: 1,
			shadowSources: [
				expect.objectContaining({ lightId: point.id, lightIndex: 0, mapType: "cube", filter: "poisson", mapCount: 6, samplerCount: 1 }),
				expect.objectContaining({ lightId: spot.id, lightIndex: 1, mapType: "2d", filter: "pcf", mapCount: 1, samplerCount: 1 }),
			],
		});

		const originalGetShadowGenerator = point.getShadowGenerator.bind(point);
		(point as unknown as { getShadowGenerator: () => null }).getShadowGenerator = () => null;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("shadow generator changed")],
		});
		(point as unknown as { getShadowGenerator: () => ShadowGenerator | null }).getShadowGenerator = originalGetShadowGenerator;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, shadowLightCount: 2, errors: [] });
	});

	test("configures one native deferred resolve and restores the exact rendering-group and G-buffer baselines", () => {
		installGeometryBuffer(scene);
		const transparent = CreateBox("Forward Transparent", { size: 40 }, scene);
		const transparentMaterial = new StandardMaterial("Forward Transparent Material", scene);
		transparentMaterial.alpha = 0.5;
		transparent.material = transparentMaterial;
		const background = CreateBox("Forward Background", { size: 400 }, scene);
		background.infiniteDistance = true;
		background.material = new StandardMaterial("Forward Background Material", scene);
		const later = CreateBox("Forward Later Group", { size: 30 }, scene);
		later.renderingGroupId = 1;
		later.material = new StandardMaterial("Forward Later Material", scene);
		const renderingGroup = (
			scene as unknown as {
				_renderingManager: {
					getRenderingGroup: (id: number) => {
						onBeforeTransparentRendering?: () => void;
						_renderSprites: () => void;
						_renderParticles: (activeMeshes: unknown) => void;
					};
				};
			}
		)._renderingManager.getRenderingGroup(0);
		let baselineCalls = 0;
		let spriteCalls = 0;
		let particleCalls = 0;
		const baseline = (): void => {
			baselineCalls++;
		};
		const baselineSprites = (): void => {
			spriteCalls++;
		};
		const baselineParticles = (_activeMeshes: unknown): void => {
			particleCalls++;
		};
		renderingGroup.onBeforeTransparentRendering = baseline;
		renderingGroup._renderSprites = baselineSprites;
		renderingGroup._renderParticles = baselineParticles;

		const configured = configureDeferredLighting(scene, camera);
		expect(configured.errors).toEqual([]);
		expect(configured).toMatchObject({
			configured: true,
			active: true,
			cameraId: camera.id,
			meshCount: 1,
			materialCount: 1,
			lightCount: 1,
			shaderLanguage: "GLSL",
			compositionMode: "hybrid-forward",
			forwardMeshCount: 3,
			transparentMeshCount: 1,
			backgroundMeshCount: 1,
			laterRenderingGroupMeshCount: 1,
		});
		expect(scene.customRenderTargets).toHaveLength(1);
		expect(scene.geometryBufferRenderer).not.toBeNull();
		renderingGroup._renderSprites();
		renderingGroup._renderParticles({});
		expect(spriteCalls).toBe(0);
		expect(particleCalls).toBe(0);

		renderingGroup.onBeforeTransparentRendering?.();
		expect(baselineCalls).toBe(1);
		expect(spriteCalls).toBe(1);
		expect(particleCalls).toBe(1);
		expect(getDeferredLightingRuntime(scene).frameCount).toBeGreaterThanOrEqual(0);
		const added = CreateBox("Dynamically Added Box", { size: 50 }, scene);
		added.material = scene.materials[0];
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("set of deferred meshes changed")],
		});
		added.dispose();
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });
		const dynamicTransparent = CreateBox("Dynamically Added Transparent", { size: 25 }, scene);
		const dynamicTransparentMaterial = new StandardMaterial("Dynamically Added Transparent Material", scene);
		dynamicTransparentMaterial.alpha = 0.5;
		dynamicTransparent.material = dynamicTransparentMaterial;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, forwardMeshCount: 4, transparentMeshCount: 2, errors: [] });
		dynamicTransparent.dispose();

		stopDeferredLighting(scene);
		expect(renderingGroup.onBeforeTransparentRendering).toBe(baseline);
		expect(renderingGroup._renderSprites).toBe(baselineSprites);
		expect(renderingGroup._renderParticles).toBe(baselineParticles);
		expect(scene.customRenderTargets).toHaveLength(0);
		expect(scene.geometryBufferRenderer).toBeNull();
	});

	test("keeps independent deferred contexts for multiple cameras while sharing and exactly releasing the scene G-buffer", () => {
		installGeometryBuffer(scene);
		const secondary = new FreeCamera("Secondary Deferred Camera", new Vector3(300, 100, -500), scene);
		secondary.setTarget(Vector3.Zero());
		const forward = new FreeCamera("Forward Camera", new Vector3(-300, 100, -500), scene);
		forward.setTarget(Vector3.Zero());
		const renderingGroup = (
			scene as unknown as {
				_renderingManager: {
					getRenderingGroup: (id: number) => {
						onBeforeTransparentRendering?: () => void;
						_renderSprites: () => void;
						_renderParticles: (activeMeshes: unknown) => void;
					};
				};
			}
		)._renderingManager.getRenderingGroup(0);
		let spriteCalls = 0;
		let particleCalls = 0;
		let callbackCalls = 0;
		const baselineCallback = (): void => {
			callbackCalls++;
		};
		const baselineSprites = (): void => {
			spriteCalls++;
		};
		const baselineParticles = (): void => {
			particleCalls++;
		};
		renderingGroup.onBeforeTransparentRendering = baselineCallback;
		renderingGroup._renderSprites = baselineSprites;
		renderingGroup._renderParticles = baselineParticles;

		expect(configureDeferredLighting(scene, camera)).toMatchObject({ active: true, cameraId: camera.id });
		const sharedCallback = renderingGroup.onBeforeTransparentRendering;
		expect(configureDeferredLighting(scene, secondary)).toMatchObject({ active: true, cameraId: secondary.id });
		expect(renderingGroup.onBeforeTransparentRendering).toBe(sharedCallback);
		expect(scene.customRenderTargets).toHaveLength(2);
		expect(camera.customRenderTargets).toHaveLength(1);
		expect(secondary.customRenderTargets).toEqual(camera.customRenderTargets);
		expect(getDeferredLightingRuntime(scene, camera)).toMatchObject({ active: true, cameraId: camera.id });
		expect(getDeferredLightingRuntime(scene, secondary)).toMatchObject({ active: true, cameraId: secondary.id });
		const sharedGeometryTarget = camera.customRenderTargets[0];
		camera.customRenderTargets.splice(0, 1);
		expect(getDeferredLightingRuntime(scene, camera)).toMatchObject({
			active: false,
			errors: [expect.stringContaining("camera-specific shared G-buffer render target was removed")],
		});
		camera.customRenderTargets.push(sharedGeometryTarget);
		expect(getDeferredLightingRuntime(scene, camera)).toMatchObject({ active: true, errors: [] });

		scene.activeCamera = forward;
		renderingGroup._renderSprites();
		renderingGroup._renderParticles({});
		renderingGroup.onBeforeTransparentRendering?.();
		expect([spriteCalls, particleCalls, callbackCalls]).toEqual([1, 1, 1]);

		scene.activeCamera = camera;
		renderingGroup._renderSprites();
		renderingGroup._renderParticles({});
		expect([spriteCalls, particleCalls]).toEqual([1, 1]);
		renderingGroup.onBeforeTransparentRendering?.();
		expect([spriteCalls, particleCalls, callbackCalls]).toEqual([2, 2, 2]);

		stopDeferredLighting(scene, camera);
		expect(scene.customRenderTargets).toHaveLength(1);
		expect(camera.customRenderTargets).toHaveLength(0);
		expect(secondary.customRenderTargets).toHaveLength(1);
		expect(scene.geometryBufferRenderer).not.toBeNull();
		expect(renderingGroup.onBeforeTransparentRendering).toBe(sharedCallback);
		expect(getDeferredLightingRuntime(scene, camera)).toMatchObject({ active: false, cameraId: camera.id });
		expect(getDeferredLightingRuntime(scene, secondary)).toMatchObject({ active: true, cameraId: secondary.id });

		secondary.dispose();
		expect(scene.customRenderTargets).toHaveLength(0);
		expect(scene.geometryBufferRenderer).toBeNull();
		expect(renderingGroup.onBeforeTransparentRendering).toBe(baselineCallback);
		expect(renderingGroup._renderSprites).toBe(baselineSprites);
		expect(renderingGroup._renderParticles).toBe(baselineParticles);
	});

	test("allocates material-scoped reflection-probe IBL, reports box projection, detects changes, and releases only owned resources", () => {
		installGeometryBuffer(scene);
		const box = scene.meshes[0];
		const material = box.material as StandardMaterial;
		const probe = new ReflectionProbe("Deferred Local Probe", 64, scene, true, false, true);
		probe.position.set(10, 20, 30);
		probe.cubeTexture.boundingBoxPosition = probe.position.clone();
		probe.cubeTexture.boundingBoxSize = new Vector3(200, 300, 400);
		probe.metadata = {
			babylonEditorReflectionProbe: { version: 1, id: "probe-local", revision: 3, intensity: 0.75, boxProjection: true },
		};
		material.reflectionTexture = probe.cubeTexture;
		scene.iblIntensity = 0.8;
		const baselineTarget = new RenderTargetTexture("External Custom Target", 32, scene);
		scene.customRenderTargets.push(baselineTarget);

		const configured = configureDeferredLighting(scene, camera);
		expect(configured.errors).toEqual([]);
		expect(configured).toMatchObject({
			active: true,
			iblActive: true,
			iblSourceCount: 1,
			iblMaximumSources: 8,
			iblReflectionProbeCount: 1,
			iblReflectionProbeNames: ["Deferred Local Probe"],
			iblProbeBlendingActive: true,
			iblProbeBlendModel: "unity-priority-box-blend-skybox-v1",
			iblProbeBlendMeshCount: 0,
			iblSources: [
				{
					index: 1,
					kind: "reflection-probe",
					name: "Deferred Local Probe",
					intensity: expect.closeTo(0.6),
					meshCount: 1,
					materialCount: 1,
					boxProjection: true,
					boxPosition: [10, 20, 30],
					boxSize: [200, 300, 400],
					probeSlot: 0,
					importance: 1,
					blendDistance: 100,
					blendModel: "unity-priority-box-blend-skybox-v1",
				},
			],
		});
		expect(scene.customRenderTargets).toHaveLength(3);
		expect(scene.customRenderTargets[0]).toBe(baselineTarget);
		const selector = scene.customRenderTargets.find((target) => target.name === "Babylon Editor Deferred IBL Selector")!;
		expect(selector.renderList?.map((mesh) => mesh.uniqueId)).toEqual([box.uniqueId]);

		(probe.metadata.babylonEditorReflectionProbe as { revision: number }).revision = 4;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("IBL environment, probe assignment, probe settings, or intensity changed")],
		});
		(probe.metadata.babylonEditorReflectionProbe as { revision: number }).revision = 3;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });

		scene.customRenderTargets.splice(scene.customRenderTargets.indexOf(selector), 1);
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: false, errors: [expect.stringContaining("IBL selector target was removed")] });
		scene.customRenderTargets.push(selector);
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });

		stopDeferredLighting(scene);
		expect(scene.customRenderTargets).toEqual([baselineTarget]);
		expect(material.reflectionTexture).toBe(probe.cubeTexture);
		expect((scene as Scene & { reflectionProbes: ReflectionProbe[] }).reflectionProbes).toContain(probe);
	});

	test("builds one per-mesh selector mask for overlapping reflection probes and invalidates exact blend settings", () => {
		installGeometryBuffer(scene);
		const box = scene.meshes[0];
		const material = box.material as StandardMaterial;
		const first = new ReflectionProbe("Blend First", 64, scene, true, false, true);
		const second = new ReflectionProbe("Blend Second", 64, scene, true, false, true);
		first.metadata = {
			babylonEditorReflectionProbe: {
				version: 2,
				id: "blend-first",
				revision: 1,
				intensity: 1,
				boxProjection: true,
				influencePosition: [0, 0, 0],
				influenceSize: [200, 200, 200],
				importance: 3,
				blendDistance: 50,
				assignedMaterialIds: [material.id],
			},
		};
		second.metadata = {
			babylonEditorReflectionProbe: {
				version: 2,
				id: "blend-second",
				revision: 1,
				intensity: 0.5,
				boxProjection: true,
				influencePosition: [25, 0, 0],
				influenceSize: [200, 200, 200],
				importance: 3,
				blendDistance: 50,
				assignedMaterialIds: [material.id],
			},
		};
		material.reflectionTexture = first.cubeTexture;

		const configured = configureDeferredLighting(scene, camera);
		expect(configured).toMatchObject({
			active: true,
			iblSourceCount: 2,
			iblReflectionProbeCount: 2,
			iblProbeBlendingActive: true,
			iblProbeBlendMeshCount: 1,
			iblSources: [
				expect.objectContaining({ name: "Blend First", probeSlot: 0, importance: 3, blendDistance: 50, meshCount: 1 }),
				expect.objectContaining({ name: "Blend Second", probeSlot: 1, importance: 3, blendDistance: 50, meshCount: 1 }),
			],
		});
		const selector = scene.customRenderTargets.find((target) => target.name === "Babylon Editor Deferred IBL Selector")!;
		expect(selector.renderList?.map((mesh) => mesh.uniqueId)).toEqual([box.uniqueId]);

		(second.metadata.babylonEditorReflectionProbe as { importance: number }).importance = 4;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({
			active: false,
			ready: false,
			errors: [expect.stringContaining("IBL environment, probe assignment, probe settings, or intensity changed")],
		});
		(second.metadata.babylonEditorReflectionProbe as { importance: number }).importance = 3;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: true, errors: [] });

		stopDeferredLighting(scene);
		expect(material.reflectionTexture).toBe(first.cubeTexture);
		expect((scene as Scene & { reflectionProbes: ReflectionProbe[] }).reflectionProbes).toContain(first);
		expect((scene as Scene & { reflectionProbes: ReflectionProbe[] }).reflectionProbes).toContain(second);
	});

	test("owns only its shadow receiver target, detects generator replacement, and retains the native shadow generator", () => {
		installGeometryBuffer(scene);
		const box = scene.meshes[0];
		box.receiveShadows = true;
		const directional = new DirectionalLight("Deferred Shadow Directional", new Vector3(0, 0, 1), scene);
		const generator = new ShadowGenerator(256, directional, true);
		generator.usePercentageCloserFiltering = true;
		Object.defineProperty(generator, "filter", { configurable: true, value: ShadowGenerator.FILTER_PCF, writable: true });
		generator.getShadowMap()!.renderList = [box];
		const baselineTarget = new RenderTargetTexture("External Custom Target", 32, scene);
		scene.customRenderTargets.push(baselineTarget);

		const configured = configureDeferredLighting(scene, camera);
		expect(configured.errors).toEqual([]);
		expect(configured).toMatchObject({ active: true, shadowLightCount: 1, shadowCasterCount: 1, shadowReceiverCount: 1 });
		expect(scene.customRenderTargets).toHaveLength(3);
		expect(scene.customRenderTargets[0]).toBe(baselineTarget);
		expect(directional.getShadowGenerator()).toBe(generator);

		const originalGetShadowGenerator = directional.getShadowGenerator.bind(directional);
		(directional as unknown as { getShadowGenerator: () => null }).getShadowGenerator = () => null;
		expect(getDeferredLightingRuntime(scene)).toMatchObject({ active: false, ready: false, errors: [expect.stringContaining("shadow generator changed")] });
		(directional as unknown as { getShadowGenerator: () => ShadowGenerator | null }).getShadowGenerator = originalGetShadowGenerator;

		stopDeferredLighting(scene);
		expect(scene.customRenderTargets).toEqual([baselineTarget]);
		expect(directional.getShadowGenerator()).toBe(generator);
		expect(generator.getShadowMap()).not.toBeNull();
	});

	test("removes instance stage overrides when Babylon methods were inherited from the rendering-group prototype", () => {
		installGeometryBuffer(scene);
		const renderingGroup = (
			scene as unknown as {
				_renderingManager: {
					getRenderingGroup: (id: number) => { _renderSprites: () => void; _renderParticles: (activeMeshes: unknown) => void };
				};
			}
		)._renderingManager.getRenderingGroup(0);
		const originalSprites = renderingGroup._renderSprites;
		const originalParticles = renderingGroup._renderParticles;
		expect(Object.prototype.hasOwnProperty.call(renderingGroup, "_renderSprites")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(renderingGroup, "_renderParticles")).toBe(false);

		expect(configureDeferredLighting(scene, camera).active).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(renderingGroup, "_renderSprites")).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(renderingGroup, "_renderParticles")).toBe(true);
		stopDeferredLighting(scene);

		expect(Object.prototype.hasOwnProperty.call(renderingGroup, "_renderSprites")).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(renderingGroup, "_renderParticles")).toBe(false);
		expect(renderingGroup._renderSprites).toBe(originalSprites);
		expect(renderingGroup._renderParticles).toBe(originalParticles);
	});
});

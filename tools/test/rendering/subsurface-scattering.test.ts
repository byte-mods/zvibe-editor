import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import "@babylonjs/core/Materials/imageProcessingConfiguration";
import { CreateBox } from "@babylonjs/core/Meshes/Builders/boxBuilder";
import { Scene } from "@babylonjs/core/scene";

import { inspectDeferredLightingCompatibility } from "../../src/rendering/deferred-lighting";
import {
	configureSubsurfaceScattering,
	diffusionProfileAssetType,
	getSubsurfaceMaterialMetadata,
	getSubsurfaceRuntime,
	getSubsurfaceRuntimeSettings,
	getSubsurfaceMaskTexture,
	setSubsurfaceMaterialMetadata,
	setSubsurfaceMaskTexture,
	serializeSubsurfaceMaskTexture,
	subsurfaceRuntimeSettingsMetadataKey,
	validateDiffusionProfileAsset,
} from "../../src/rendering/subsurface-scattering";
import {
	serializeSubsurfaceTransportTexture,
	setSubsurfaceTransportTexture,
	subsurfaceTransportBackend,
	subsurfaceTransportLightingSignature,
	subsurfaceTransportMeshSignature,
} from "../../src/rendering/subsurface-transport";

function profile(index: number): any {
	return {
		version: 1,
		type: diffusionProfileAssetType,
		id: `profile-${index}`,
		name: `Profile ${index}`,
		revision: 1,
		scatteringDistance: [1 + index * 0.01, 0.5, 0.25],
		transmissionTint: [1, 0.5, 0.25],
		thicknessRemap: [0, 5],
		worldScale: 1,
		indexOfRefraction: 1.4,
		path: `assets/Profile ${index}.diffusionprofile.json`,
		contentRevision: `${index}`.padStart(64, "0"),
	};
}

function assign(material: PBRMaterial, index: number, mode: "subsurface-scattering" | "translucent" = "subsurface-scattering"): void {
	setSubsurfaceMaterialMetadata(material, {
		version: 2,
		revision: 1,
		mode,
		profile: profile(index),
		subsurfaceMask: 0.75,
		subsurfaceMaskTexture: null,
		transmissionEnabled: true,
		transmissionIntensity: 0.8,
		thicknessMultiplier: 2,
		useThicknessTexture: false,
	});
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
	(scene as any)._prePassRenderer = {};
	(scene as any)._subSurfaceConfiguration = configuration;
	scene.enableSubSurfaceForPrePass = () => configuration as any;
}

describe("rendering/subsurface-scattering", () => {
	let engine: NullEngine;
	let scene: Scene;

	beforeEach(() => {
		engine = new NullEngine();
		engine.getCaps().drawBuffersExtension = true;
		engine.getCaps().maxDrawBuffers = 8;
		scene = new Scene(engine);
		installSubsurfacePrePass(scene);
		const camera = new FreeCamera("Camera", new Vector3(0, 0, -500), scene);
		camera.setTarget(Vector3.Zero());
		scene.activeCamera = camera;
	});

	afterEach(() => {
		scene.dispose();
		engine.dispose();
	});

	test("strictly validates portable diffusion profiles", () => {
		const { path: _path, contentRevision: _contentRevision, ...source } = profile(0);
		const valid = validateDiffusionProfileAsset(source);
		expect(valid).toMatchObject({ id: "profile-0", scatteringDistance: [1, 0.5, 0.25], thicknessRemap: [0, 5] });
		expect(() => validateDiffusionProfileAsset({ ...valid, unknown: true })).toThrow("unknown fields");
		expect(() => validateDiffusionProfileAsset({ ...valid, thicknessRemap: [5, 1] })).toThrow("maximum must be greater");
		expect(() => validateDiffusionProfileAsset({ ...valid, scatteringDistance: [0, 1, 1] })).toThrow("0.001 through 1000");
	});

	test("configures native Burley scattering, transmission, quality, and deferred forward composition", () => {
		const mesh = CreateBox("Skin Mesh", { size: 100 }, scene);
		const material = new PBRMaterial("Skin Material", scene);
		mesh.material = material;
		assign(material, 1);
		scene.metadata = {
			[subsurfaceRuntimeSettingsMetadataKey]: { version: 1, revision: 3, enabled: true, quality: "custom", sampleBudget: 88, metersPerUnit: 0.01 },
		};

		const runtime = configureSubsurfaceScattering(scene);
		expect(runtime).toMatchObject({
			configured: true,
			backend: "babylon-native-burley-screen-space-mask-v3",
			profileCapacity: 15,
			profileCount: 1,
			materialCount: 1,
			scatteringMaterialCount: 1,
			transmissionMaterialCount: 1,
			quality: "custom",
			sampleBudget: 88,
			metersPerUnit: 0.01,
			maskTargetAllocated: true,
			maskMeshCount: 1,
		});
		expect(runtime.profiles[0].effectiveScatteringDistance[0]).toBeCloseTo(1.01);
		expect(runtime.profiles[0]).toMatchObject({ effectiveScatteringDistance: [expect.any(Number), 0.5, 0.25], materialCount: 1 });
		expect(runtime.materials[0]).toMatchObject({ minimumThickness: 0, maximumThickness: 10, transmissionIntensity: 0.8, subsurfaceMaskChannel: "red" });
		expect(material.subSurface).toMatchObject({ isScatteringEnabled: true, isTranslucencyEnabled: true, minimumThickness: 0, maximumThickness: 10 });
		expect(ShaderStore.IncludesShadersStore.diffusionProfile).toContain("diffusionS[15]");
		expect(ShaderStore.IncludesShadersStoreWGSL.diffusionProfile).toContain("array<vec3f,15>");
		expect(ShaderStore.ShadersStore.subSurfaceScatteringPixelShader).toContain("_SssSampleBudget=88");

		const compatibility = inspectDeferredLightingCompatibility(scene, scene.activeCamera!);
		expect(compatibility.meshes).not.toContain(mesh);
		expect(compatibility.forwardMeshes).toContain(mesh);
		expect(compatibility.warnings).toContainEqual(expect.stringContaining("native forward/pre-pass SSS path"));
		expect(getSubsurfaceRuntime(scene).frameId).toBe(scene.getFrameId());
	});

	test("migrates runtime policy and executes a signed camera-independent RGBM transport cache", () => {
		const mesh = CreateBox("Transport Skin Mesh", { size: 100 }, scene);
		const material = new PBRMaterial("Transport Skin Material", scene);
		mesh.material = material;
		assign(material, 4);
		const texture = new RawTexture(new Uint8Array([255, 64, 32, 64]), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
		texture.name = "assets/Lighting/Subsurface/transport.png";
		texture.url = texture.name;
		texture.gammaSpace = false;
		setSubsurfaceTransportTexture(material, mesh.id, 1, "c".repeat(64), texture);
		const metadata = getSubsurfaceMaterialMetadata(material)!;
		setSubsurfaceMaterialMetadata(material, {
			...metadata,
			version: 3,
			transportCaches: [
				{
					version: 1,
					backend: subsurfaceTransportBackend,
					ownership: "editor-generated",
					revision: 1,
					meshId: mesh.id,
					meshName: mesh.name,
					texture: serializeSubsurfaceTransportTexture(texture),
					texturePath: texture.name,
					contentRevision: "c".repeat(64),
					uvChannel: "uv0",
					resolution: 16,
					sampleCount: 4,
					maxDistance: 1000,
					bias: 0.01,
					shadowing: true,
					dilation: 2,
					encoding: "linear-rgbm8",
					rgbmRange: 16,
					intensity: 0.75,
					profileId: metadata.profile.id,
					profileRevision: metadata.profile.revision,
					profileContentRevision: metadata.profile.contentRevision,
					geometrySignature: subsurfaceTransportMeshSignature(mesh, "uv0"),
					lightingSignature: subsurfaceTransportLightingSignature(scene),
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
		scene.metadata = {
			[subsurfaceRuntimeSettingsMetadataKey]: {
				version: 2,
				revision: 2,
				enabled: true,
				quality: "high",
				sampleBudget: 64,
				metersPerUnit: 0.01,
				transportMode: "baked-ray-traced",
				transportIntensity: 1.5,
			},
		};

		const active = configureSubsurfaceScattering(scene);
		expect(active).toMatchObject({
			configured: true,
			ready: false,
			transport: {
				enabled: true,
				ready: false,
				backend: subsurfaceTransportBackend,
				cacheCount: 1,
				activeCacheCount: 1,
				staleCacheCount: 0,
				textureCount: 1,
				globalIntensity: 1.5,
				totalRayCount: 512,
			},
		});
		expect(active.transport.caches[0]).toMatchObject({
			materialId: material.id,
			materialName: material.name,
			meshId: mesh.id,
			active: true,
			stale: false,
			textureName: texture.name,
			textureReady: false,
		});

		mesh.position.x = 10;
		const stale = getSubsurfaceRuntime(scene);
		expect(stale.transport).toMatchObject({ enabled: true, ready: false, activeCacheCount: 0, staleCacheCount: 1 });
		expect(stale.transport.caches[0].staleReasons).toContain("mesh geometry, transform, or UVs changed");

		const migrated = getSubsurfaceRuntimeSettings(
			Object.assign(scene, {
				metadata: {
					[subsurfaceRuntimeSettingsMetadataKey]: { version: 1, revision: 3, enabled: true, quality: "medium", sampleBudget: 40, metersPerUnit: 0.01 },
				},
			})
		);
		expect(migrated).toMatchObject({ version: 2, transportMode: "screen-space", transportIntensity: 1 });
	});

	test("renders an independent red-channel mask target and restores the native shader contract on clear", () => {
		const mesh = CreateBox("Masked Skin Mesh", { size: 100 }, scene);
		const material = new PBRMaterial("Masked Skin Material", scene);
		mesh.material = material;
		const mask = new RawTexture(new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255]), 2, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
		mask.name = "assets/Skin Mask.png";
		setSubsurfaceMaskTexture(material, mask);
		setSubsurfaceMaterialMetadata(material, {
			version: 2,
			revision: 1,
			mode: "subsurface-scattering",
			profile: profile(2),
			subsurfaceMask: 0.6,
			subsurfaceMaskTexture: serializeSubsurfaceMaskTexture(mask),
			transmissionEnabled: false,
			transmissionIntensity: 1,
			thicknessMultiplier: 1,
			useThicknessTexture: false,
		});

		const active = configureSubsurfaceScattering(scene);
		expect(active).toMatchObject({
			configured: true,
			maskTargetAllocated: true,
			maskMeshCount: 1,
			maskTextureCount: 1,
			materials: [
				expect.objectContaining({
					subsurfaceMask: 0.6,
					subsurfaceMaskTextureName: "assets/Skin Mask.png",
					subsurfaceMaskTextureReady: false,
					subsurfaceMaskChannel: "red",
				}),
			],
		});
		expect(getSubsurfaceMaskTexture(material)).toBe(mask);
		expect(scene.customRenderTargets.filter((target) => target.name === "Babylon Editor Subsurface Mask")).toHaveLength(1);
		expect(ShaderStore.ShadersStore.subSurfaceScatteringPixelShader).toContain("subsurfaceMaskSampler");
		expect(ShaderStore.ShadersStoreWGSL.subSurfaceScatteringPixelShader).toContain("subsurfaceMaskSampler");

		const rebuilt = configureSubsurfaceScattering(scene);
		expect(rebuilt).toMatchObject({ configured: true, maskTextureCount: 1 });
		expect(scene.customRenderTargets.filter((target) => target.name === "Babylon Editor Subsurface Mask")).toHaveLength(1);

		setSubsurfaceMaterialMetadata(material, null);
		material.subSurface.isScatteringEnabled = false;
		material.subSurface.isTranslucencyEnabled = false;
		const cleared = configureSubsurfaceScattering(scene);
		expect(cleared).toMatchObject({ configured: false, maskTargetAllocated: false });
		expect(scene.customRenderTargets.filter((target) => target.name === "Babylon Editor Subsurface Mask")).toHaveLength(0);
		expect(scene.subSurfaceConfiguration?.enabled).toBe(false);
		expect(scene.prePassRenderer).not.toBeNull();
		expect(ShaderStore.ShadersStore.subSurfaceScatteringPixelShader).not.toContain("subsurfaceMaskSampler");
		expect(ShaderStore.ShadersStoreWGSL.subSurfaceScatteringPixelShader).not.toContain("subsurfaceMaskSampler");
	});

	test("supports fifteen effective profiles and rejects a sixteenth without partial native activation", () => {
		for (let index = 0; index < 15; index++) {
			const material = new PBRMaterial(`Material ${index}`, scene);
			assign(material, index);
		}
		const accepted = configureSubsurfaceScattering(scene);
		expect(accepted).toMatchObject({ configured: true, profileCount: 15, materialCount: 15, errors: [] });
		expect(scene.subSurfaceConfiguration?.ssDiffusionProfileColors).toHaveLength(15);

		const extra = new PBRMaterial("Material 15", scene);
		assign(extra, 15);
		const rejected = configureSubsurfaceScattering(scene);
		expect(rejected).toMatchObject({ configured: false, profileCount: 0, materialCount: 16 });
		expect(rejected.errors).toEqual([expect.stringContaining("view limit is 15")]);
		expect(
			scene.materials
				.filter((material) => material instanceof PBRMaterial)
				.every((material) => !material.subSurface.isScatteringEnabled && !material.subSurface.isTranslucencyEnabled)
		).toBe(true);
		expect(scene.subSurfaceConfiguration?.enabled).toBe(false);
	});

	test("persists portable material metadata through Babylon serialization and disables owned native execution when cleared", () => {
		const material = new PBRMaterial("Serialized Skin", scene);
		assign(material, 3, "translucent");
		const configured = configureSubsurfaceScattering(scene);
		expect(configured).toMatchObject({ configured: true, ready: true, transmissionMaterialCount: 1 });

		const serialized = material.serialize();
		const restoredEngine = new NullEngine();
		const restoredScene = new Scene(restoredEngine);
		const restored = PBRMaterial.Parse(serialized, restoredScene, "");
		expect(restored.metadata).toMatchObject({
			babylonEditorSubsurfaceScattering: {
				version: 3,
				revision: 1,
				mode: "translucent",
				profile: { id: "profile-3", path: "assets/Profile 3.diffusionprofile.json" },
			},
		});
		restoredScene.dispose();
		restoredEngine.dispose();

		setSubsurfaceMaterialMetadata(material, null);
		material.subSurface.isScatteringEnabled = false;
		material.subSurface.isTranslucencyEnabled = false;
		const disabled = configureSubsurfaceScattering(scene);
		expect(disabled).toMatchObject({ configured: false, ready: false, materialCount: 0 });
		expect(scene.subSurfaceConfiguration?.enabled).toBe(false);
		expect(scene.prePassRenderer).not.toBeNull();
	});

	test("disposes a pre-pass renderer owned solely by the portable subsurface runtime", () => {
		const ownedEngine = new NullEngine();
		ownedEngine.getCaps().drawBuffersExtension = true;
		ownedEngine.getCaps().maxDrawBuffers = 8;
		const ownedScene = new Scene(ownedEngine);
		const camera = new FreeCamera("Owned Camera", new Vector3(0, 0, -500), ownedScene);
		camera.setTarget(Vector3.Zero());
		ownedScene.activeCamera = camera;
		const mesh = CreateBox("Owned Skin Mesh", { size: 100 }, ownedScene);
		const material = new PBRMaterial("Owned Skin Material", ownedScene);
		mesh.material = material;
		assign(material, 5);

		const active = configureSubsurfaceScattering(ownedScene);
		expect(active.configured).toBe(true);
		expect(ownedScene.prePassRenderer).not.toBeNull();
		setSubsurfaceMaterialMetadata(material, null);
		material.subSurface.isScatteringEnabled = false;
		material.subSurface.isTranslucencyEnabled = false;
		const cleared = configureSubsurfaceScattering(ownedScene);
		expect(cleared).toMatchObject({ configured: false, prePassEnabled: false, postProcessReady: false });
		expect(ownedScene.subSurfaceConfiguration).toBeNull();
		expect(ownedScene.prePassRenderer).toBeNull();

		ownedScene.dispose();
		ownedEngine.dispose();
	});
});

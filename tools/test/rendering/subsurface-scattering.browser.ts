import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { WebGPUEngine } from "@babylonjs/core/Engines/webgpuEngine";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { PBRMaterial } from "@babylonjs/core/Materials/PBR/pbrMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { CreateSphere } from "@babylonjs/core/Meshes/Builders/sphereBuilder";
import { Scene } from "@babylonjs/core/scene";
import glslangFactory from "@babylonjs/core/assets/glslang/glslang.cjs";
import twgslFactory from "@babylonjs/core/assets/twgsl/twgsl.cjs";

import {
	configureSubsurfaceScattering,
	diffusionProfileAssetType,
	getSubsurfaceMaterialMetadata,
	getSubsurfaceRuntime,
	setSubsurfaceMaterialMetadata,
	setSubsurfaceMaskTexture,
	serializeSubsurfaceMaskTexture,
	subsurfaceRuntimeSettingsMetadataKey,
} from "../../src/rendering/subsurface-scattering";
import {
	serializeSubsurfaceTransportTexture,
	setSubsurfaceTransportTexture,
	subsurfaceTransportBackend,
	subsurfaceTransportLightingSignature,
	subsurfaceTransportMeshSignature,
} from "../../src/rendering/subsurface-transport";

declare const __SUBSURFACE_SCATTERING_TARGET__: "webgl2" | "webgpu";

async function createEngine(canvas: HTMLCanvasElement): Promise<Engine | WebGPUEngine | null> {
	if (__SUBSURFACE_SCATTERING_TARGET__ === "webgpu") {
		const adapter = await (navigator as unknown as { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu?.requestAdapter();
		if (!adapter) {
			return null;
		}
		const glslang = glslangFactory(new URL("./glslang.wasm", location.href).href);
		const twgsl = await twgslFactory(new URL("./twgsl.wasm", location.href).href);
		return WebGPUEngine.CreateAsync(canvas, { glslangOptions: { glslang }, twgslOptions: { twgsl } });
	}
	return new Engine(canvas, false, { disableWebGL2Support: false, preserveDrawingBuffer: true, stencil: true });
}

function delay(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 16));
}

async function renderUntil(scene: Scene, predicate: () => boolean, frames = 180): Promise<number> {
	for (let frame = 1; frame <= frames; frame++) {
		const engine = scene.getEngine();
		engine.beginFrame();
		scene.render();
		engine.endFrame();
		if (predicate()) {
			return frame;
		}
		await delay();
	}
	throw new Error(`Subsurface scattering did not become ready: ${JSON.stringify(getSubsurfaceRuntime(scene))}`);
}

async function readFrame(scene: Scene): Promise<Uint8Array> {
	const engine = scene.getEngine();
	engine.beginFrame();
	scene.render();
	engine.endFrame();
	const pixels = await engine.readPixels(0, 0, engine.getRenderWidth(), engine.getRenderHeight());
	return pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
}

function compare(left: Uint8Array, right: Uint8Array): { changedPixels: number; absoluteDifference: number; maximumDifference: number } {
	let changedPixels = 0;
	let absoluteDifference = 0;
	let maximumDifference = 0;
	for (let offset = 0; offset < Math.min(left.length, right.length); offset += 4) {
		const difference = Math.abs(left[offset] - right[offset]) + Math.abs(left[offset + 1] - right[offset + 1]) + Math.abs(left[offset + 2] - right[offset + 2]);
		if (difference >= 3) {
			changedPixels++;
		}
		absoluteDifference += difference;
		maximumDifference = Math.max(maximumDifference, difference);
	}
	return { changedPixels, absoluteDifference, maximumDifference };
}

async function run(): Promise<void> {
	const canvas = document.createElement("canvas");
	canvas.width = 320;
	canvas.height = 180;
	document.body.appendChild(canvas);
	const engine = await createEngine(canvas);
	if (!engine) {
		document.body.dataset.result = "unavailable";
		document.body.dataset.details = JSON.stringify({ target: __SUBSURFACE_SCATTERING_TARGET__, navigatorGpu: Boolean((navigator as any).gpu) });
		return;
	}
	if (__SUBSURFACE_SCATTERING_TARGET__ === "webgl2") {
		engine.getCaps().parallelShaderCompile = undefined;
	}

	const scene = new Scene(engine);
	scene.clearColor = new Color4(0.005, 0.005, 0.008, 1);
	scene.imageProcessingConfiguration.toneMappingEnabled = false;
	scene.imageProcessingConfiguration.exposure = 1;
	const camera = new FreeCamera("SSS Camera", new Vector3(0, 0, -420), scene);
	camera.setTarget(Vector3.Zero());
	camera.minZ = 1;
	camera.maxZ = 1200;
	scene.activeCamera = camera;

	const light = new PointLight("SSS Key", new Vector3(-65, 55, -180), scene);
	light.diffuse = new Color3(1, 0.35, 0.2);
	light.specular = Color3.Black();
	light.intensity = 2.5;
	light.range = 650;
	light.falloffType = PointLight.FALLOFF_GLTF;

	const material = new PBRMaterial("GPU Skin", scene);
	material.albedoColor = new Color3(0.9, 0.4, 0.28);
	material.metallic = 0;
	material.roughness = 1;
	const sphere = CreateSphere("GPU Skin Sphere", { diameter: 220, segments: 64 }, scene);
	sphere.material = material;
	const patternedMaskData = new Uint8Array(256 * 128 * 4);
	for (let y = 0; y < 128; y++) {
		for (let x = 0; x < 256; x++) {
			const offset = (y * 256 + x) * 4;
			patternedMaskData[offset] = x < 128 ? 255 : 0;
			patternedMaskData[offset + 3] = 255;
		}
	}
	const patternedMask = new RawTexture(patternedMaskData, 256, 128, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
	patternedMask.name = "assets/GPU Skin Pattern Mask.png";
	patternedMask.gammaSpace = false;
	setSubsurfaceMaskTexture(material, patternedMask);

	setSubsurfaceMaterialMetadata(material, {
		version: 2,
		revision: 1,
		mode: "subsurface-scattering",
		profile: {
			version: 1,
			type: diffusionProfileAssetType,
			id: "gpu-skin-profile",
			name: "GPU Skin",
			revision: 1,
			scatteringDistance: [18, 7, 3],
			transmissionTint: [1, 0.35, 0.2],
			thicknessRemap: [0, 12],
			worldScale: 1,
			indexOfRefraction: 1.4,
			path: "assets/GPU Skin.diffusionprofile.json",
			contentRevision: "b".repeat(64),
		},
		subsurfaceMask: 1,
		subsurfaceMaskTexture: serializeSubsurfaceMaskTexture(patternedMask),
		transmissionEnabled: false,
		transmissionIntensity: 1,
		thicknessMultiplier: 1,
		useThicknessTexture: false,
	});
	scene.metadata = {
		[subsurfaceRuntimeSettingsMetadataKey]: { version: 1, revision: 1, enabled: true, quality: "high", sampleBudget: 64, metersPerUnit: 0.01 },
	};
	const configured = configureSubsurfaceScattering(scene);
	if (configured.errors.length) {
		throw new Error(configured.errors.join(" "));
	}
	const readinessFrames = await renderUntil(scene, () => getSubsurfaceRuntime(scene).ready);
	const active = structuredClone(getSubsurfaceRuntime(scene));
	const patternedPixels = await readFrame(scene);
	const profileShaderCapacity =
		__SUBSURFACE_SCATTERING_TARGET__ === "webgpu"
			? ShaderStore.IncludesShadersStoreWGSL.diffusionProfile.includes("array<vec3f,15>")
			: ShaderStore.IncludesShadersStore.diffusionProfile.includes("diffusionS[15]");
	const sampleBudgetShader =
		__SUBSURFACE_SCATTERING_TARGET__ === "webgpu"
			? ShaderStore.ShadersStoreWGSL.subSurfaceScatteringPixelShader.includes("_SssSampleBudget=64u")
			: ShaderStore.ShadersStore.subSurfaceScatteringPixelShader.includes("_SssSampleBudget=64");

	const whiteMask = new RawTexture(new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255]), 2, 2, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
	whiteMask.name = "assets/GPU Skin White Mask.png";
	whiteMask.gammaSpace = false;
	setSubsurfaceMaskTexture(material, whiteMask);
	setSubsurfaceMaterialMetadata(material, {
		...material.metadata!.babylonEditorSubsurfaceScattering,
		revision: 2,
		subsurfaceMaskTexture: serializeSubsurfaceMaskTexture(whiteMask),
	});
	const whiteConfiguration = configureSubsurfaceScattering(scene);
	if (whiteConfiguration.errors.length) {
		throw new Error(whiteConfiguration.errors.join(" "));
	}
	await renderUntil(scene, () => getSubsurfaceRuntime(scene).ready && getSubsurfaceRuntime(scene).materials[0]?.subsurfaceMaskTextureName === whiteMask.name);
	const white = structuredClone(getSubsurfaceRuntime(scene));
	const scatteringPixels = await readFrame(scene);
	const maskDifference = compare(patternedPixels, scatteringPixels);

	const transportTexture = new RawTexture(new Uint8Array([255, 96, 48, 48]), 1, 1, Constants.TEXTUREFORMAT_RGBA, scene, false, false);
	transportTexture.name = "assets/GPU Skin Offscreen Transport.png";
	transportTexture.url = transportTexture.name;
	transportTexture.gammaSpace = false;
	setSubsurfaceTransportTexture(material, sphere.id, 1, "c".repeat(64), transportTexture);
	const transportMetadata = getSubsurfaceMaterialMetadata(material)!;
	setSubsurfaceMaterialMetadata(material, {
		...transportMetadata,
		version: 3,
		revision: 3,
		transportCaches: [
			{
				version: 1,
				backend: subsurfaceTransportBackend,
				ownership: "editor-generated",
				revision: 1,
				meshId: sphere.id,
				meshName: sphere.name,
				texture: serializeSubsurfaceTransportTexture(transportTexture),
				texturePath: transportTexture.name,
				contentRevision: "c".repeat(64),
				uvChannel: "uv0",
				resolution: 16,
				sampleCount: 8,
				maxDistance: 1000,
				bias: 0.01,
				shadowing: true,
				dilation: 2,
				encoding: "linear-rgbm8",
				rgbmRange: 16,
				intensity: 0.5,
				profileId: transportMetadata.profile.id,
				profileRevision: transportMetadata.profile.revision,
				profileContentRevision: transportMetadata.profile.contentRevision,
				geometrySignature: subsurfaceTransportMeshSignature(sphere, "uv0"),
				lightingSignature: subsurfaceTransportLightingSignature(scene),
				coveredTexels: 192,
				overlapTexels: 0,
				tracedTexels: 192,
				hitTexels: 180,
				rayCount: 1536,
				minimumThickness: 180,
				maximumThickness: 220,
				averageThickness: 200,
				limitations: ["Static bounded cache."],
			},
		],
	});
	scene.metadata![subsurfaceRuntimeSettingsMetadataKey] = {
		version: 2,
		revision: 2,
		enabled: true,
		quality: "high",
		sampleBudget: 64,
		metersPerUnit: 0.01,
		transportMode: "baked-ray-traced",
		transportIntensity: 1,
	};
	const transportConfiguration = configureSubsurfaceScattering(scene);
	if (transportConfiguration.errors.length) {
		throw new Error(transportConfiguration.errors.join(" "));
	}
	await renderUntil(scene, () => getSubsurfaceRuntime(scene).ready && getSubsurfaceRuntime(scene).transport.activeCacheCount === 1);
	const transport = structuredClone(getSubsurfaceRuntime(scene));
	const transportPixels = await readFrame(scene);
	const transportDifference = compare(scatteringPixels, transportPixels);
	scene.metadata![subsurfaceRuntimeSettingsMetadataKey] = {
		...scene.metadata![subsurfaceRuntimeSettingsMetadataKey],
		revision: 3,
		transportMode: "screen-space",
	};
	const screenConfiguration = configureSubsurfaceScattering(scene);
	if (screenConfiguration.errors.length) {
		throw new Error(screenConfiguration.errors.join(" "));
	}
	await renderUntil(scene, () => getSubsurfaceRuntime(scene).ready && !getSubsurfaceRuntime(scene).transport.enabled);

	setSubsurfaceMaterialMetadata(material, {
		...material.metadata!.babylonEditorSubsurfaceScattering,
		revision: 4,
		subsurfaceMask: 0,
	});
	const maskedConfiguration = configureSubsurfaceScattering(scene);
	if (maskedConfiguration.errors.length) {
		throw new Error(maskedConfiguration.errors.join(" "));
	}
	await renderUntil(scene, () => getSubsurfaceRuntime(scene).ready && getSubsurfaceRuntime(scene).scatteringMaterialCount === 0);
	const masked = structuredClone(getSubsurfaceRuntime(scene));
	const controlPixels = await readFrame(scene);
	const difference = compare(scatteringPixels, controlPixels);

	setSubsurfaceMaterialMetadata(material, null);
	material.subSurface.isScatteringEnabled = false;
	material.subSurface.isTranslucencyEnabled = false;
	const disabled = configureSubsurfaceScattering(scene);
	await renderUntil(scene, () => !getSubsurfaceRuntime(scene).configured, 30);
	const center = (Math.floor(engine.getRenderHeight() / 2) * engine.getRenderWidth() + Math.floor(engine.getRenderWidth() / 2)) * 4;
	const evidence = {
		target: __SUBSURFACE_SCATTERING_TARGET__,
		backend: engine.getClassName(),
		readinessFrames,
		active,
		white,
		masked,
		disabled,
		difference,
		maskDifference,
		transport,
		transportDifference,
		patternedCenter: Array.from(patternedPixels.subarray(center, center + 4)),
		scatteringCenter: Array.from(scatteringPixels.subarray(center, center + 4)),
		controlCenter: Array.from(controlPixels.subarray(center, center + 4)),
		profileShaderCapacity,
		sampleBudgetShader,
		maskShaderRestored:
			!ShaderStore.ShadersStore.subSurfaceScatteringPixelShader.includes("subsurfaceMaskSampler") &&
			!ShaderStore.ShadersStoreWGSL.subSurfaceScatteringPixelShader.includes("subsurfaceMaskSampler"),
	};
	const passed =
		active.configured &&
		active.ready &&
		active.prePassEnabled &&
		active.postProcessReady &&
		active.profileCapacity === 15 &&
		active.profileCount === 1 &&
		active.materialCount === 1 &&
		active.scatteringMaterialCount === 1 &&
		active.maskTargetAllocated &&
		active.maskTargetReady &&
		active.maskTextureCount === 1 &&
		active.maskMeshCount === 1 &&
		active.materials[0]?.subsurfaceMaskTextureName === patternedMask.name &&
		active.materials[0]?.subsurfaceMaskChannel === "red" &&
		active.sampleBudget === 64 &&
		active.materials[0]?.materialId === material.id &&
		white.ready &&
		white.materials[0]?.subsurfaceMaskTextureName === whiteMask.name &&
		transport.ready &&
		transport.transport.enabled &&
		transport.transport.backend === subsurfaceTransportBackend &&
		transport.transport.cacheCount === 1 &&
		transport.transport.activeCacheCount === 1 &&
		transport.transport.staleCacheCount === 0 &&
		transport.transport.caches[0]?.textureName === transportTexture.name &&
		transportDifference.changedPixels > 100 &&
		transportDifference.absoluteDifference > 1000 &&
		transportDifference.maximumDifference > 3 &&
		masked.configured &&
		masked.ready &&
		masked.scatteringMaterialCount === 0 &&
		masked.materials[0]?.subsurfaceMask === 0 &&
		!disabled.configured &&
		!disabled.ready &&
		evidence.profileShaderCapacity &&
		evidence.sampleBudgetShader &&
		evidence.maskShaderRestored &&
		maskDifference.changedPixels > 50 &&
		maskDifference.absoluteDifference > 500 &&
		maskDifference.maximumDifference > 3 &&
		difference.changedPixels > 100 &&
		difference.changedPixels < 57600 &&
		difference.absoluteDifference > 1000 &&
		difference.maximumDifference > 3;
	document.body.dataset.result = passed ? "passed" : "failed";
	document.body.dataset.details = JSON.stringify(evidence);
	scene.dispose();
	engine.dispose();
}

run().catch((error) => {
	document.body.dataset.result = "failed";
	document.body.dataset.details = error instanceof Error ? (error.stack ?? error.message) : String(error);
});
